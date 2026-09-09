/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalThemeGallery.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { alert } from '../../../../base/browser/ui/aria/aria.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Delayer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IPrimalVibeService, PRIMAL_VIBES } from '../../primalVibes/browser/primalVibes.js';
import { PrimalThemePreviewer } from '../../primalVibes/common/primalThemePreviewer.js';
import { computeThemeReadability, IPrimalReadabilityVerdict, PRIMAL_UNCHECKED_VERDICT } from '../common/primalThemeReadability.js';
import { describeVerdictCounts, describeVerdictLevel } from '../common/primalThemeVerdictLabel.js';
import { IPrimalThemeEntry, PRIMAL_THEME_GALLERY_EDITOR_ID, PRIMAL_THEME_IMPORT_COMMAND_ID, PrimalThemeGrouping } from '../common/primalThemeGallery.js';
import { createLoadedThemeColorSource } from './primalThemeColorSource.js';
import { buildCatalogue, filterCatalogue, groupCatalogue, modeLabel, sourceLabel } from '../common/primalThemeGalleryModel.js';
import { PrimalThemeGalleryInput } from './primalThemeGalleryInput.js';
import { swatchForTheme } from './primalThemeSwatch.js';

const $ = DOM.$;

/**
 * Ids for the `aria-controls` / `aria-labelledby` wiring below.
 *
 * A counter rather than a constant because a second editor group can hold a
 * second gallery pane in the same document, and two elements sharing an id would
 * point both panes' relationships at whichever rendered first.
 */
let elementIdCounter = 0;
function uniqueElementId(prefix: string): string {
	return `${prefix}-${++elementIdCounter}`;
}

/** Below this editor width the page drops to a single column of controls. */
const NARROW_WIDTH_THRESHOLD = 640;

/** How long typing has to settle before the grid re-filters. */
const SEARCH_DELAY_MS = 200;

/**
 * How many themes are loaded and measured before the loop yields to the event
 * loop.
 *
 * MEASURED, because "will a hundred cards jank" deserves a number rather than a
 * guess. A verdict is ~540 CIEDE2000 distances (the 16-slot ANSI ramp and the
 * semantic groups, each pair under four observers), which timed at 0.74 ms per
 * theme on this machine over `primal-basalt-color-theme.json`. A hundred themes
 * is therefore ~74 ms of arithmetic in total — real, but not a frame killer.
 * What actually costs is `ensureLoaded`: reading and parsing each theme's JSON
 * off disk. So the work is chunked and yielded rather than run in one blocking
 * pass, and every card renders immediately with an honest "Not checked" verdict
 * that is filled in as the answers arrive. First paint is independent of
 * catalogue size: a hundred themes cost a hundred small awaits, not one long
 * frame. The grid itself is plain CSS `auto-fill` with no per-card JavaScript
 * layout, so the browser lays out a hundred cards in one pass.
 */
const MEASURE_BATCH_SIZE = 4;

/** Everything the pane keeps for one rendered card. */
interface IRenderedCard {
	readonly entry: IPrimalThemeEntry;
	readonly element: HTMLButtonElement;
	readonly swatch: HTMLElement;
	/** Holds the state WORD — "Current" or "Previewing" — or nothing. */
	readonly state: HTMLElement;
	readonly verdictIcon: HTMLElement;
	readonly verdictLabel: HTMLElement;
}

/**
 * The Primal theme gallery: a searchable, groupable grid of every colour theme
 * the window has, with a live preview and a measured readability verdict on
 * every card.
 *
 * Three states have to be told apart on a card — applied, previewing, focused —
 * and none of them may be carried by hue. Applied is a check glyph plus the word
 * "Current"; previewing is the word "Previewing" plus a dashed edge; focused is
 * the workbench focus ring. All three survive a greyscale screenshot, and the
 * two that are states rather than a cursor position are in the card's accessible
 * name as well, because the focus ring and the previewing edge are drawn from
 * one token and shape alone leaves them a hairline apart.
 */
export class PrimalThemeGalleryEditor extends EditorPane {

	static readonly ID: string = PRIMAL_THEME_GALLERY_EDITOR_ID;

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly cardDisposables = this._register(new DisposableStore());
	private readonly searchDelayer = this._register(new Delayer<void>(SEARCH_DELAY_MS));

	private previewer: PrimalThemePreviewer | undefined;

	private scrollContainer: HTMLElement | undefined;
	private sectionsContainer: HTMLElement | undefined;
	private statusLine: HTMLElement | undefined;
	private searchInput: InputBox | undefined;
	private groupingButtons: readonly HTMLButtonElement[] = [];

	private themesBySettingsId = new Map<string, IWorkbenchColorTheme>();
	private verdicts = new Map<string, IPrimalReadabilityVerdict>();
	private catalogue: readonly IPrimalThemeEntry[] = [];
	private cards: IRenderedCard[] = [];

	private grouping: PrimalThemeGrouping = 'family';
	private query = '';
	private tabbableCard: HTMLButtonElement | undefined;
	private previewingSettingsId: string | undefined;
	private suppressNextPreview = false;
	private refreshToken = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchThemeService private readonly workbenchThemeService: IWorkbenchThemeService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService
	) {
		super(PrimalThemeGalleryEditor.ID, group, telemetryService, themeService, storageService);
	}

	//#region Layout

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.previewer = this.editorDisposables.add(new PrimalThemePreviewer(this.workbenchThemeService, this.logService));

		const scrollContainer = DOM.append(parent, $('.primal-theme-gallery'));
		const page = DOM.append(scrollContainer, $('.primal-theme-gallery-page'));

		// Built before the controls so the search box can point `aria-controls` at
		// it; appended below, in reading order.
		const sections = $('.primal-theme-sections');
		sections.id = uniqueElementId('primal-theme-sections');
		this.scrollContainer = scrollContainer;
		this.sectionsContainer = sections;

		this.renderHeader(page);
		this.renderControls(page);

		// A live region, not a plain div: the result count and the whole
		// empty-search state change under a user who has not moved focus, and a
		// change nothing announces is a change a screen-reader user cannot see.
		const statusLine = DOM.append(page, $('.primal-theme-gallery-status'));
		statusLine.setAttribute('role', 'status');
		statusLine.setAttribute('aria-live', 'polite');
		statusLine.setAttribute('aria-atomic', 'true');
		this.statusLine = statusLine;

		DOM.append(page, sections);

		this.editorDisposables.add(DOM.addDisposableListener(sections, DOM.EventType.KEY_DOWN, event => this.onGridKeyDown(event)));
		this.editorDisposables.add(DOM.addDisposableListener(scrollContainer, DOM.EventType.KEY_DOWN, event => this.onPaneKeyDown(event)));
		this.editorDisposables.add(this.workbenchThemeService.onDidColorThemeChange(() => {
			// The previewer is the authority on what is being previewed: a preview
			// can end without this pane asking, when something else applies a theme.
			this.markPreviewingCard(this.previewer?.previewedTheme);
			this.markAppliedCard();
		}));

		this.refresh().catch(onUnexpectedError);
	}

	private renderHeader(page: HTMLElement): void {
		const header = DOM.append(page, $('.primal-theme-gallery-header'));
		DOM.append(header, $('h1.primal-theme-gallery-title', undefined, localize('primalGallery.title', "Themes")));
		DOM.append(header, $('p.primal-theme-gallery-subtitle', undefined, localize('primalGallery.subtitle', "Every colour theme this window has. Arrow through them to preview; press Escape to put back the one you had.")));
	}

	private renderControls(page: HTMLElement): void {
		const controls = DOM.append(page, $('.primal-theme-gallery-controls'));

		const searchHost = DOM.append(controls, $('.primal-theme-gallery-search'));
		this.searchInput = this.editorDisposables.add(new InputBox(searchHost, this.contextViewService, {
			placeholder: localize('primalGallery.searchPlaceholder', "Search by name, family or light/dark"),
			ariaLabel: localize('primalGallery.searchAria', "Search themes"),
			inputBoxStyles: defaultInputBoxStyles
		}));
		// The box says what it filters, so a reader arriving at it is told there is
		// a results region and where the count it hears is coming from.
		if (this.sectionsContainer) {
			this.searchInput.inputElement.setAttribute('aria-controls', this.sectionsContainer.id);
		}
		this.editorDisposables.add(this.searchInput.onDidChange(value => {
			this.searchDelayer.trigger(async () => {
				this.query = value;
				this.renderSections();
			}).catch(() => {
				// A superseded keystroke cancels the delayer; nothing to report.
			});
		}));

		const rail = DOM.append(controls, $('.primal-theme-gallery-rail'));
		DOM.append(rail, $('span.primal-theme-gallery-rail-label', undefined, localize('primalGallery.groupBy', "Group by")));
		this.groupingButtons = [
			this.renderGroupingButton(rail, 'family', localize('primalGallery.groupBy.family', "Family")),
			this.renderGroupingButton(rail, 'mode', localize('primalGallery.groupBy.mode', "Light / dark"))
		];
		this.markGrouping();

		const importButton = DOM.append(controls, $('button.primal-theme-gallery-import')) as HTMLButtonElement;
		importButton.type = 'button';
		DOM.append(importButton, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		DOM.append(importButton, $('span', undefined, localize('primalGallery.import', "Import palette…")));
		this.editorDisposables.add(DOM.addDisposableListener(importButton, DOM.EventType.CLICK, () => {
			this.commandService.executeCommand(PRIMAL_THEME_IMPORT_COMMAND_ID).catch(onUnexpectedError);
		}));
	}

	private renderGroupingButton(rail: HTMLElement, grouping: PrimalThemeGrouping, label: string): HTMLButtonElement {
		const button = DOM.append(rail, $('button.primal-theme-gallery-rail-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.setAttribute('data-grouping', grouping);
		this.editorDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			this.grouping = grouping;
			this.markGrouping();
			this.renderSections();
		}));
		return button;
	}

	/** The selected grouping is marked by a word state (`aria-pressed`) and an edge, not a fill. */
	private markGrouping(): void {
		for (const button of this.groupingButtons) {
			const selected = button.getAttribute('data-grouping') === this.grouping;
			button.classList.toggle('selected', selected);
			button.setAttribute('aria-pressed', String(selected));
		}
	}

	//#endregion

	//#region Catalogue

	private async refresh(): Promise<void> {
		const token = ++this.refreshToken;
		let themes: IWorkbenchColorTheme[];
		try {
			themes = await this.workbenchThemeService.getColorThemes();
		} catch (error) {
			this.logService.error('[primalThemeGallery] Failed to read the installed color themes', error);
			const message = localize('primalGallery.loadFailed', "The list of installed themes could not be read.");
			this.showStatus(message);
			// An empty pane with a polite message is indistinguishable from a pane
			// still loading, so the failure is asserted rather than offered.
			alert(message);
			return;
		}
		if (token !== this.refreshToken) {
			return; // superseded
		}

		this.themesBySettingsId = new Map(themes.map(theme => [theme.settingsId, theme]));
		this.catalogue = buildCatalogue(
			themes.map(theme => ({
				settingsId: theme.settingsId,
				label: theme.label,
				type: theme.type,
				extensionId: theme.extensionData?.extensionId
			})),
			PRIMAL_VIBES
		);
		this.renderSections();
		this.measureAll(token).catch(onUnexpectedError);
	}

	/**
	 * Loads every theme and measures it, a few at a time.
	 *
	 * Cards are already on screen by the time this runs; each one is updated in
	 * place as its answer arrives, so a large catalogue degrades into a slower
	 * fill rather than a slower first paint.
	 */
	private async measureAll(token: number): Promise<void> {
		const themes = [...this.themesBySettingsId.values()];
		for (let index = 0; index < themes.length; index += MEASURE_BATCH_SIZE) {
			if (token !== this.refreshToken) {
				return;
			}
			const settled = await Promise.all(themes.slice(index, index + MEASURE_BATCH_SIZE).map(theme => this.measure(theme)));
			if (token !== this.refreshToken) {
				return;
			}
			// Only the cards this batch answered for. Repainting all of them per
			// batch would rebuild every swatch subtree and recompose every card's
			// aria-label once per batch — quadratic in the catalogue size, for a
			// pass in which at most MEASURE_BATCH_SIZE cards can have changed.
			this.updateMeasuredCards(new Set(settled.filter((settingsId): settingsId is string => settingsId !== undefined)));
		}
	}

	/** Measures one theme, answering the settings id whose card now has a new answer. */
	private async measure(theme: IWorkbenchColorTheme): Promise<string | undefined> {
		if (this.verdicts.has(theme.settingsId)) {
			return undefined;
		}
		try {
			if (theme instanceof ColorThemeData && !theme.isLoaded) {
				await theme.ensureLoaded(this.extensionResourceLoaderService);
			}
		} catch (error) {
			// A theme whose file cannot be read stays "Not checked"; that is an
			// honest answer and it is stated on the card in words.
			this.logService.warn(`[primalThemeGallery] Could not load the color theme '${theme.settingsId}'`, error);
			return undefined;
		}
		this.verdicts.set(theme.settingsId, computeThemeReadability(createLoadedThemeColorSource(theme)));
		return theme.settingsId;
	}

	//#endregion

	//#region Rendering

	private renderSections(): void {
		const container = this.sectionsContainer;
		if (!container) {
			return;
		}
		this.cardDisposables.clear();
		DOM.clearNode(container);
		this.cards = [];
		this.tabbableCard = undefined;

		const matches = filterCatalogue(this.catalogue, this.query);
		if (matches.length === 0) {
			this.showStatus(localize('primalGallery.noMatches', "No theme matches \"{0}\".", this.query.trim()));
			return;
		}
		this.showStatus(localize('primalGallery.count', "{0} of {1} themes", matches.length, this.catalogue.length));

		for (const group of groupCatalogue(matches, this.grouping)) {
			const section = DOM.append(container, $('.primal-theme-section'));
			const label = DOM.append(section, $('.primal-theme-section-label', undefined, group.label));
			label.id = uniqueElementId('primal-theme-section-label');

			// A named listbox of options rather than anonymous divs of buttons: the
			// grouping is what tells a family or a light/dark set apart, and a
			// reader with no container role is told neither which group a card is
			// in nor how many cards there are to arrow through.
			const grid = DOM.append(section, $('.primal-theme-grid'));
			grid.setAttribute('role', 'listbox');
			grid.setAttribute('aria-labelledby', label.id);
			for (const [index, entry] of group.entries.entries()) {
				this.renderCard(grid, entry, index + 1, group.entries.length);
			}
		}

		this.markAppliedCard();
		// A re-render (a search, a regrouping) does not end a preview, so the marker
		// is put back on the freshly built cards rather than silently dropped.
		this.markPreviewingCard(this.previewingSettingsId);
		this.updateMeasuredCards();
		this.ensureTabbable();
	}

	private renderCard(grid: HTMLElement, entry: IPrimalThemeEntry, positionInSet: number, setSize: number): void {
		const element = DOM.append(grid, $('button.primal-theme-card')) as HTMLButtonElement;
		element.type = 'button';
		element.tabIndex = -1;
		element.setAttribute('data-settings-id', entry.settingsId);
		element.setAttribute('role', 'option');
		element.setAttribute('aria-posinset', String(positionInSet));
		element.setAttribute('aria-setsize', String(setSize));

		const swatch = DOM.append(element, $('.primal-theme-swatch'));

		const nameRow = DOM.append(element, $('.primal-theme-name'));
		DOM.append(nameRow, $('span.primal-theme-current-check' + ThemeIcon.asCSSSelector(Codicon.check)));
		DOM.append(nameRow, $('span.primal-theme-label', undefined, entry.shortLabel));

		const state = DOM.append(element, $('span.primal-theme-state'));

		const meta = DOM.append(element, $('.primal-theme-meta'));
		DOM.append(meta, $('span.primal-theme-mode', undefined, modeLabel(entry.mode)));
		DOM.append(meta, $('span.primal-theme-sep', undefined, '·'));
		DOM.append(meta, $('span.primal-theme-source', undefined, sourceLabel(entry.source)));

		const verdictRow = DOM.append(element, $('.primal-theme-verdict'));
		const verdictIcon = DOM.append(verdictRow, $('span.primal-theme-verdict-icon'));
		const verdictLabel = DOM.append(verdictRow, $('span.primal-theme-verdict-label'));

		const card: IRenderedCard = { entry, element, swatch, state, verdictIcon, verdictLabel };
		this.cards.push(card);

		this.paintSwatch(card);
		this.paintVerdict(card);

		this.cardDisposables.add(DOM.addDisposableListener(element, DOM.EventType.FOCUS, () => {
			this.setTabbable(element);
			const suppressed = this.suppressNextPreview;
			this.suppressNextPreview = false;
			// Focusing the card that is already applied previews nothing, so it must
			// not claim to: the two states have to stay distinguishable.
			const isApplied = this.appliedSettingsId() === entry.settingsId;
			this.markPreviewingCard(isApplied || suppressed ? undefined : entry.settingsId);
			if (!suppressed) {
				this.previewer?.preview(this.themesBySettingsId.get(entry.settingsId));
			}
		}));
		this.cardDisposables.add(DOM.addDisposableListener(element, DOM.EventType.CLICK, () => {
			this.apply(entry).catch(onUnexpectedError);
		}));
	}

	private paintSwatch(card: IRenderedCard): void {
		const theme = this.themesBySettingsId.get(card.entry.settingsId);
		const colors = theme ? swatchForTheme(theme) : undefined;
		DOM.clearNode(card.swatch);
		card.swatch.classList.toggle('unavailable', !colors);
		if (!colors) {
			// No hue is available to preview, so say so rather than paint a guess.
			card.swatch.textContent = localize('primalGallery.swatchUnavailable', "No preview");
			return;
		}
		card.swatch.textContent = '';
		card.swatch.style.backgroundColor = colors.chrome;
		const slab = DOM.append(card.swatch, $('.primal-theme-swatch-slab'));
		slab.style.backgroundColor = colors.editor;
		const accent = DOM.append(slab, $('.primal-theme-swatch-accent'));
		accent.style.backgroundColor = colors.accent;
	}

	private paintVerdict(card: IRenderedCard): void {
		const verdict = this.verdictFor(card);
		const presentation = describeVerdictLevel(verdict.level);
		card.verdictIcon.className = 'primal-theme-verdict-icon ' + ThemeIcon.asClassName(presentation.icon);
		card.verdictLabel.textContent = presentation.label;
		card.element.title = `${presentation.summary}\n${describeVerdictCounts(verdict)}`;
		this.paintCardState(card);
	}

	private verdictFor(card: IRenderedCard): IPrimalReadabilityVerdict {
		return this.verdicts.get(card.entry.settingsId) ?? PRIMAL_UNCHECKED_VERDICT;
	}

	/**
	 * The card's state as a WORD, or nothing when it is in neither state.
	 *
	 * The dashed edge and the check glyph are the redundant cues. This is the one
	 * a screen reader can read, and the one that survives the case where the
	 * previewed card is also the focused card — the focus ring and the previewing
	 * edge are drawn from the same token, so shape alone leaves "focused" and
	 * "focused and previewing" a solid-versus-dashed hairline apart.
	 */
	private cardStateWord(settingsId: string): string {
		if (settingsId === this.previewingSettingsId) {
			return localize('primalGallery.previewing', "Previewing");
		}
		if (settingsId === this.appliedSettingsId()) {
			return localize('primalGallery.current', "Current");
		}
		return '';
	}

	/** Puts the state word on the card and into its accessible name. */
	private paintCardState(card: IRenderedCard): void {
		const state = this.cardStateWord(card.entry.settingsId);
		card.state.textContent = state;
		const verdict = this.verdictFor(card);
		const description = localize(
			'primalGallery.cardAria',
			"{0}. {1}. {2}. Readability: {3}. {4}",
			card.entry.label,
			modeLabel(card.entry.mode),
			sourceLabel(card.entry.source),
			describeVerdictLevel(verdict.level).label,
			describeVerdictCounts(verdict)
		);
		card.element.setAttribute('aria-label', state.length > 0
			? localize('primalGallery.cardAriaState', "{0}. {1}", state, description)
			: description);
	}

	/** Repaints every card, or only the ones named. */
	private updateMeasuredCards(measured?: ReadonlySet<string>): void {
		for (const card of this.cards) {
			if (measured && !measured.has(card.entry.settingsId)) {
				continue;
			}
			this.paintSwatch(card);
			this.paintVerdict(card);
		}
	}

	/**
	 * The theme the user actually has.
	 *
	 * NOT `getColorTheme()`: `applyTheme` assigns the current theme and fires its
	 * change event before it reaches the `settingsTarget !== 'preview'` storage
	 * guard, so during a live preview the theme service answers with the previewed
	 * theme. Marking that card as the applied one would put the check glyph — the
	 * one non-hue marker for "this is what you are wearing" — on a theme that is
	 * not applied, and take it off the one that is.
	 */
	private appliedSettingsId(): string {
		return this.previewer?.baselineTheme.settingsId ?? this.workbenchThemeService.getColorTheme().settingsId;
	}

	/** The applied theme is marked by a check glyph and the word, never by a fill. */
	private markAppliedCard(): void {
		const applied = this.appliedSettingsId();
		for (const card of this.cards) {
			const isApplied = card.entry.settingsId === applied;
			card.element.classList.toggle('current', isApplied);
			card.element.setAttribute('aria-selected', String(isApplied));
			this.paintCardState(card);
		}
	}

	/** The previewed card is marked by a dashed edge and the word on the card. */
	private markPreviewingCard(settingsId: string | undefined): void {
		this.previewingSettingsId = settingsId;
		for (const card of this.cards) {
			card.element.classList.toggle('previewing', card.entry.settingsId === settingsId);
			this.paintCardState(card);
		}
	}

	private showStatus(text: string): void {
		if (this.statusLine) {
			this.statusLine.textContent = text;
		}
	}

	//#endregion

	//#region Applying

	private async apply(entry: IPrimalThemeEntry): Promise<void> {
		try {
			if (entry.vibeId) {
				// A vibe moves three theme slots together, so it goes through the
				// vibe service rather than through the previewer's colour-only path.
				await this.vibeService.applyVibe(entry.vibeId);
				this.previewer?.adoptAppliedTheme();
			} else {
				const theme = this.themesBySettingsId.get(entry.settingsId);
				if (!theme) {
					return;
				}
				await this.previewer?.apply(theme);
			}
		} catch (error) {
			this.logService.error(`[primalThemeGallery] Failed to apply '${entry.settingsId}'`, error);
			return;
		}
		this.markPreviewingCard(undefined);
		this.markAppliedCard();
	}

	//#endregion

	//#region Keyboard

	private setTabbable(element: HTMLButtonElement): void {
		if (this.tabbableCard === element) {
			return;
		}
		if (this.tabbableCard) {
			this.tabbableCard.tabIndex = -1;
		}
		element.tabIndex = 0;
		this.tabbableCard = element;
	}

	/**
	 * One Tab stop into the grid: the last focused card, or the applied one.
	 *
	 * The applied theme rather than the first card in the catalogue, because
	 * focusing a card previews it — seeding the tab stop to `cards[0]` meant
	 * opening the pane repainted the whole workbench to whichever theme sorted
	 * first, and put the reading position on a card that is not the one the user
	 * is wearing.
	 */
	private ensureTabbable(): void {
		const applied = this.appliedSettingsId();
		const element = this.tabbableCard && this.cards.some(card => card.element === this.tabbableCard)
			? this.tabbableCard
			: (this.cards.find(card => card.entry.settingsId === applied) ?? this.cards.at(0))?.element;
		if (element) {
			this.setTabbable(element);
		}
	}

	private focusedCardIndex(): number {
		const active = DOM.getActiveElement();
		return this.cards.findIndex(card => card.element === active);
	}

	private focusCardAt(index: number): void {
		const card = this.cards.at(Math.max(0, Math.min(index, this.cards.length - 1)));
		card?.element.focus();
	}

	/**
	 * Moves one row up or down.
	 *
	 * The grid is `auto-fill`, so the column count is whatever the width allows
	 * and is not knowable from the model. Rows are read back off the laid-out
	 * DOM — cards on the same `offsetTop` are one row — and the target is the
	 * card in the neighbouring row whose horizontal centre is nearest. That also
	 * carries focus across a section boundary, which a fixed column stride
	 * would not.
	 */
	private moveVertically(from: number, direction: 1 | -1): void {
		const current = this.cards[from]?.element;
		if (!current) {
			return;
		}
		const currentTop = current.offsetTop;
		const currentCentre = current.offsetLeft + current.offsetWidth / 2;

		let targetTop: number | undefined;
		let best: HTMLButtonElement | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;
		const ordered = direction === 1 ? this.cards : [...this.cards].reverse();
		for (const card of ordered) {
			const top = card.element.offsetTop;
			if (direction === 1 ? top <= currentTop : top >= currentTop) {
				continue;
			}
			if (targetTop === undefined) {
				targetTop = top;
			} else if (top !== targetTop) {
				continue;
			}
			const distance = Math.abs(card.element.offsetLeft + card.element.offsetWidth / 2 - currentCentre);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = card.element;
			}
		}
		best?.focus();
	}

	private onGridKeyDown(event: KeyboardEvent): void {
		const keyboardEvent = new StandardKeyboardEvent(event);
		const index = this.focusedCardIndex();
		if (index < 0) {
			return;
		}

		switch (keyboardEvent.keyCode) {
			case KeyCode.RightArrow:
				this.focusCardAt(index + 1);
				break;
			case KeyCode.LeftArrow:
				this.focusCardAt(index - 1);
				break;
			case KeyCode.DownArrow:
				this.moveVertically(index, 1);
				break;
			case KeyCode.UpArrow:
				this.moveVertically(index, -1);
				break;
			case KeyCode.Home:
				this.focusCardAt(0);
				break;
			case KeyCode.End:
				this.focusCardAt(this.cards.length - 1);
				break;
			default:
				return; // Enter and Space are the button's own business
		}
		keyboardEvent.preventDefault();
		keyboardEvent.stopPropagation();
	}

	/**
	 * Escape puts back the theme the user had, from anywhere in the pane.
	 *
	 * Bound on the pane root rather than on the grid: the subtitle promises
	 * Escape without qualification, and a preview outlives the focus that started
	 * it, so a user who arrows onto a card and then Shift+Tabs back to the search
	 * box to narrow the list would otherwise be left wearing a theme they never
	 * chose with no way to say no. The arrow, Home and End keys stay on the grid,
	 * where a focused card is what they act on.
	 */
	private onPaneKeyDown(event: KeyboardEvent): void {
		const keyboardEvent = new StandardKeyboardEvent(event);
		if (keyboardEvent.keyCode !== KeyCode.Escape) {
			return;
		}
		// In the search box Escape also clears the query, which is the standard
		// escape hatch there and was doing nothing at all.
		if (this.searchInput?.hasFocus() && this.searchInput.value.length > 0) {
			this.searchInput.value = '';
		}
		this.markPreviewingCard(undefined);
		this.previewer?.revert().catch(onUnexpectedError);
		keyboardEvent.preventDefault();
		keyboardEvent.stopPropagation();
	}

	//#endregion

	//#region Editor lifecycle

	override async setInput(input: PrimalThemeGalleryInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.previewer?.captureBaseline();
		await this.refresh();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			// The user may have changed themes by another route while this pane
			// sat in the background, so the theme to revert to is re-read.
			this.previewer?.captureBaseline();
			this.markAppliedCard();
		} else {
			this.markPreviewingCard(undefined);
			this.previewer?.revert().catch(onUnexpectedError);
		}
	}

	override clearInput(): void {
		this.markPreviewingCard(undefined);
		this.previewer?.revert().catch(onUnexpectedError);
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.ensureTabbable();
		const target = this.tabbableCard;
		if (target) {
			// Focusing a card previews it. Opening the pane must not repaint the
			// whole workbench before the user has touched anything, so this one
			// programmatic focus is exempt.
			this.suppressNextPreview = true;
			target.focus();
			this.suppressNextPreview = false;
		} else {
			this.searchInput?.focus();
		}
	}

	override layout(dimension: Dimension): void {
		this.scrollContainer?.classList.toggle('narrow', dimension.width < NARROW_WIDTH_THRESHOLD);
	}

	//#endregion
}
