/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ICustomizationItemConfig } from './customizationsToolbar.contribution.js';
import { CustomizationsTreeDataSource, ICustomizationLeaf, ICustomizationLeafContextMenu, ICustomizationLeafSource } from './customizationsTreeItems.js';

const $ = DOM.$;

/**
 * Rows rendered eagerly per expanded category. Larger sections get a
 * "Show all N" row that opens the full customizations editor instead of
 * appending every item to the sidebar DOM.
 */
const MAX_VISIBLE_LEAVES = 20;

/**
 * Behaviour the tree needs from a focusable row to drive keyboard navigation.
 */
export interface ICustomizationsTreeNode {
	/** Runs the row's primary action (open the section, item or full list). */
	activate(): void;
	/** The enclosing category element, for leaf rows. */
	readonly parent: HTMLElement | undefined;
	/** Present on category rows that can be expanded in place. */
	readonly expandable?: {
		isExpanded(): boolean;
		setExpanded(expanded: boolean): void;
		firstLeaf(): HTMLElement | undefined;
	};
}

/**
 * What a category node needs from the tree that owns it.
 */
export interface ICustomizationsTreeHost {
	isExpanded(categoryId: string): boolean;
	setExpanded(categoryId: string, expanded: boolean): void;
	registerNode(element: HTMLElement, node: ICustomizationsTreeNode): void;
	/** The set of rendered rows changed (rows were added, removed or resized). */
	notifyContentHeightChanged(): void;
}

/**
 * A rendered child row that is reused across re-renders as long as its leaf
 * id survives, so an unchanged row keeps its DOM node, focus and hover.
 */
interface ILeafRow extends IDisposable {
	readonly element: HTMLElement;
	/** Listeners and hovers bound to the row's current content. */
	readonly store: DisposableStore;
}

/**
 * Which child row owned focus before a re-render, so it can be handed back.
 */
type FocusedChild =
	| { readonly kind: 'leaf'; readonly id: string }
	| { readonly kind: 'showAll' };

/**
 * One category row of the sidebar customizations tree (Agents, Skills, MCP
 * Servers, ...). Clicking the label opens the full customizations editor;
 * the chevron toggles an inline, indented list of the category's items.
 *
 * Rows are not Tab stops on their own: the owning tree keeps exactly one row
 * tabbable (roving tabindex) and moves focus with the arrow keys.
 */
export class CustomizationCategoryNode extends Disposable {

	private static _groupIdSeed = 0;

	readonly element: HTMLElement;

	private readonly _label: string;
	private readonly _leafSource: ICustomizationLeafSource | undefined;
	private readonly _count: IObservable<number> | undefined;
	private readonly _chevron: HTMLElement | undefined;
	private readonly _children: HTMLElement | undefined;
	/** "Show all N" row, kept detached while not needed. */
	private readonly _showAll: HTMLElement | undefined;
	private readonly _showAllLabel: HTMLElement | undefined;
	/** "Loading..." / "No items" placeholder, kept detached while not needed. */
	private readonly _message: HTMLElement | undefined;
	private readonly _childrenRender = this._register(new MutableDisposable<DisposableStore>());
	/** Rendered leaf rows by leaf id; empty while collapsed. */
	private readonly _rows = this._register(new DisposableMap<string, ILeafRow>());
	private _expanded = false;
	/** Rendered child rows in document order; empty while collapsed. */
	private _leafElements: readonly HTMLElement[] = [];

	/** The category's action id, stable across re-renders of the tree. */
	get id(): string {
		return this._action.id;
	}

	/**
	 * Every focusable row this category contributes to the tree, in document
	 * order: the category itself followed by its rendered children.
	 */
	get focusableElements(): readonly HTMLElement[] {
		return [this.element, ...this._leafElements];
	}

	constructor(
		parent: HTMLElement,
		private readonly _action: IAction,
		private readonly _config: ICustomizationItemConfig | undefined,
		private readonly _host: ICustomizationsTreeHost,
		dataSource: CustomizationsTreeDataSource,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();

		const config = _config;
		this._label = _action.label;
		this._leafSource = config ? dataSource.createLeafSource(config) : undefined;
		this._count = config ? derived(reader => dataSource.readCount(config, reader)) : undefined;

		this.element = DOM.append(parent, $('.customizations-node.category', { role: 'treeitem', 'aria-level': '1', tabindex: '-1' }));
		const row = this._renderRow();

		if (this._leafSource) {
			const groupId = `customizations-tree-group-${CustomizationCategoryNode._groupIdSeed++}`;
			this._chevron = this._renderChevron(row, groupId);
			this._children = DOM.append(this.element, $('.customizations-children', { role: 'group', id: groupId, 'aria-label': this._label }));
			this._children.hidden = true;
			// An expandable treeitem must expose its collapsed state too.
			this.element.setAttribute('aria-expanded', 'false');
			this._showAllLabel = $('span.customizations-row-label');
			this._showAll = this._createShowAll(this._showAllLabel);
			this._message = $('.customizations-message');
		}

		this._host.registerNode(this.element, {
			parent: undefined,
			activate: () => this._runAction(),
			expandable: this._leafSource ? {
				isExpanded: () => this._expanded,
				setExpanded: expanded => this.setExpanded(expanded),
				firstLeaf: () => this._leafElements.at(0),
			} : undefined,
		});

		if (this._leafSource && this._host.isExpanded(this._action.id)) {
			this._applyExpanded(true);
		}
	}

	/**
	 * Expands or collapses the category in place and persists the choice.
	 */
	setExpanded(expanded: boolean): void {
		if (!this._leafSource || expanded === this._expanded) {
			return;
		}
		this._applyExpanded(expanded);
		this._host.setExpanded(this._action.id, expanded);
	}

	/** Id of the rendered leaf row that currently owns focus, if any. */
	focusedLeafId(): string | undefined {
		const focused = this._focusedChild();
		return focused?.kind === 'leaf' ? focused.id : undefined;
	}

	/** The rendered row for a leaf id, while the category is expanded. */
	leafElement(id: string): HTMLElement | undefined {
		return this._rows.get(id)?.element;
	}

	private _renderRow(): HTMLElement {
		const row = DOM.append(this.element, $('.customizations-row.category'));
		const icon = DOM.append(row, $('span.customizations-row-icon'));
		if (this._config) {
			icon.classList.add(...ThemeIcon.asClassNameArray(this._config.icon));
		}
		const label = DOM.append(row, $('span.customizations-row-label'));
		label.textContent = this._label;
		const count = DOM.append(row, $('span.customizations-row-count'));

		const countObservable = this._count;
		if (countObservable) {
			this._register(autorun(reader => {
				const value = countObservable.read(reader);
				count.textContent = value > 0 ? String(value) : '';
				this.element.setAttribute('aria-label', value > 0 ? localize('customizationCategoryWithCount', "{0}, {1}", this._label, value) : this._label);
			}));
		} else {
			this.element.setAttribute('aria-label', this._label);
		}

		// Clicking the label keeps today's behaviour: open the full customizations editor.
		this._register(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this._runAction()));
		return row;
	}

	private _renderChevron(row: HTMLElement, groupId: string): HTMLElement {
		// Out of the Tab order: the treeitem's Right/Left arrows expand and
		// collapse, so the tree contributes a single Tab stop. It stays a real
		// button for pointer users and assistive tech.
		const chevron = DOM.append(row, $('button.customizations-chevron', { type: 'button', tabindex: '-1', 'aria-controls': groupId, 'aria-expanded': 'false' }));
		DOM.append(chevron, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
		this._setChevronLabel(chevron, false);

		this._register(DOM.addDisposableListener(chevron, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.setExpanded(!this._expanded);
		}));
		// Enter/Space activate the button natively (as a click). Keep those keys
		// from bubbling so the tree does not also activate the category row.
		this._register(DOM.addDisposableListener(chevron, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				e.stopPropagation();
			}
		}));
		return chevron;
	}

	private _setChevronLabel(chevron: HTMLElement, expanded: boolean): void {
		chevron.setAttribute('aria-label', expanded
			? localize('collapseCustomizationCategory', "Collapse {0}", this._label)
			: localize('expandCustomizationCategory', "Expand {0}", this._label));
	}

	private _applyExpanded(expanded: boolean): void {
		if (!this._chevron || !this._children) {
			return;
		}
		this._expanded = expanded;
		this.element.setAttribute('aria-expanded', String(expanded));
		this.element.classList.toggle('expanded', expanded);
		this._chevron.setAttribute('aria-expanded', String(expanded));
		this._chevron.classList.toggle('expanded', expanded);
		this._setChevronLabel(this._chevron, expanded);

		if (expanded) {
			this._children.hidden = false;
			this._renderChildren(this._children);
		} else {
			if (DOM.isAncestor(DOM.getActiveElement(), this._children)) {
				this.element.focus();
			}
			this._childrenRender.clear();
			this._rows.clearAndDisposeAll();
			DOM.clearNode(this._children);
			this._children.hidden = true;
			this._leafElements = [];
		}
		this._host.notifyContentHeightChanged();
	}

	private _renderChildren(children: HTMLElement): void {
		const source = this._leafSource;
		if (!source) {
			return;
		}
		const store = new DisposableStore();
		this._childrenRender.value = store;

		// Lazy: the first expansion is what kicks off the section fetch.
		const loaded = observableValue<boolean>('customizationsCategoryLoaded', false);
		source.load().then(() => {
			if (!store.isDisposed) {
				loaded.set(true, undefined);
			}
		}, onUnexpectedError);

		store.add(autorun(reader => {
			const leaves = source.leaves.read(reader);
			const total = this._count?.read(reader) ?? leaves.length;
			const isLoaded = loaded.read(reader);
			this._reconcileLeaves(children, leaves, total, isLoaded);
			this._host.notifyContentHeightChanged();
		}));
	}

	/**
	 * Patches the rendered rows to match `leaves`: rows whose id survives are
	 * refilled in place, stale rows are removed, new rows inserted, and only
	 * rows whose position changed are moved. If the row that owned focus was
	 * removed or moved, focus returns to the row with the same id, else to
	 * the category row, so a keyboard user is never dropped out of the tree.
	 */
	private _reconcileLeaves(children: HTMLElement, leaves: readonly ICustomizationLeaf[], total: number, isLoaded: boolean): void {
		const focused = this._focusedChild();
		const visible = distinctById(leaves).slice(0, MAX_VISIBLE_LEAVES);
		const visibleIds = new Set(visible.map(leaf => leaf.id));
		for (const id of [...this._rows.keys()]) {
			if (!visibleIds.has(id)) {
				this._rows.deleteAndDispose(id);
			}
		}
		this._message?.remove();
		this._showAll?.remove();

		const ordered = visible.map(leaf => this._renderLeaf(leaf).element);
		ordered.forEach((element, index) => {
			const current = children.children.item(index);
			if (current !== element) {
				children.insertBefore(element, current);
			}
		});

		if (visible.length === 0 && this._message) {
			this._message.textContent = isLoaded
				? localize('customizationCategoryEmpty', "No items")
				: localize('customizationCategoryLoading', "Loading...");
			children.appendChild(this._message);
		}
		const showAll = total > visible.length ? this._showAll : undefined;
		if (showAll) {
			this._setShowAllLabel(showAll, total);
			children.appendChild(showAll);
		}
		this._leafElements = showAll ? [...ordered, showAll] : ordered;
		this._restoreFocus(children, focused);
	}

	private _focusedChild(): FocusedChild | undefined {
		const active = DOM.getActiveElement();
		if (!active || !this._children || !DOM.isAncestor(active, this._children)) {
			return undefined;
		}
		if (this._showAll && DOM.isAncestor(active, this._showAll)) {
			return { kind: 'showAll' };
		}
		for (const [id, row] of this._rows) {
			if (DOM.isAncestor(active, row.element)) {
				return { kind: 'leaf', id };
			}
		}
		return undefined;
	}

	private _restoreFocus(children: HTMLElement, focused: FocusedChild | undefined): void {
		if (!focused || DOM.isAncestor(DOM.getActiveElement(), children)) {
			return;
		}
		const target = focused.kind === 'leaf'
			? this._rows.get(focused.id)?.element
			: this._showAll?.parentElement === children ? this._showAll : undefined;
		(target ?? this.element).focus();
	}

	private _renderLeaf(leaf: ICustomizationLeaf): ILeafRow {
		let row = this._rows.get(leaf.id);
		if (!row) {
			row = this._createLeafRow();
			this._rows.set(leaf.id, row);
		}
		this._fillLeafRow(row, leaf);
		return row;
	}

	private _createLeafRow(): ILeafRow {
		const element = $('.customizations-node.leaf', { role: 'treeitem', 'aria-level': '2', tabindex: '-1' });
		const store = new DisposableStore();
		return {
			element,
			store,
			dispose: () => {
				store.dispose();
				element.remove();
			},
		};
	}

	private _fillLeafRow(row: ILeafRow, leaf: ICustomizationLeaf): void {
		row.store.clear();
		const node = row.element;
		DOM.clearNode(node);
		node.classList.toggle('disabled', leaf.disabled);
		node.setAttribute('aria-label', [leaf.label, ...leaf.detailParts].join(', '));

		const rowElement = DOM.append(node, $('.customizations-row.leaf'));
		const icon = DOM.append(rowElement, $('span.customizations-row-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(leaf.icon));
		const text = DOM.append(rowElement, $('span.customizations-leaf-text'));
		const name = DOM.append(text, $('span.customizations-leaf-name'));
		name.textContent = leaf.label;
		if (leaf.detailParts.length > 0) {
			const detail = DOM.append(text, $('span.customizations-leaf-detail'));
			for (const part of leaf.detailParts) {
				const partElement = DOM.append(detail, $('span.customizations-leaf-detail-part'));
				partElement.textContent = part;
			}
		}

		const hover = leaf.hover;
		if (hover) {
			row.store.add(this._hoverService.setupDelayedHover(rowElement, () => ({ content: hover })));
		}
		row.store.add(DOM.addDisposableListener(rowElement, DOM.EventType.CLICK, () => this._openLeaf(leaf)));
		const getContextMenu = leaf.getContextMenu;
		if (getContextMenu) {
			row.store.add(DOM.addDisposableListener(rowElement, DOM.EventType.CONTEXT_MENU, e => this._showContextMenu(e, getContextMenu())));
		}
		this._host.registerNode(node, { parent: this.element, activate: () => this._openLeaf(leaf) });
	}

	private _createShowAll(label: HTMLElement): HTMLElement {
		const node = $('.customizations-node.leaf.show-all', { role: 'treeitem', 'aria-level': '2', tabindex: '-1' });
		const row = DOM.append(node, $('.customizations-row.leaf.show-all'));
		const icon = DOM.append(row, $('span.customizations-row-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowSmallRight));
		DOM.append(row, label);

		this._register(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this._runAction()));
		this._host.registerNode(node, { parent: this.element, activate: () => this._runAction() });
		return node;
	}

	private _setShowAllLabel(node: HTMLElement, total: number): void {
		const showAllLabel = localize('showAllCustomizations', "Show all {0}", total);
		if (this._showAllLabel) {
			this._showAllLabel.textContent = showAllLabel;
		}
		node.setAttribute('aria-label', showAllLabel);
	}

	private _showContextMenu(e: MouseEvent, menu: ICustomizationLeafContextMenu): void {
		DOM.EventHelper.stop(e, true);
		if (menu.actions.length === 0) {
			return;
		}
		const anchor = new StandardMouseEvent(DOM.getWindow(this.element), e);
		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => menu.actions,
			getActionsContext: () => menu.context,
		});
	}

	private _openLeaf(leaf: ICustomizationLeaf): void {
		leaf.open().catch(onUnexpectedError);
	}

	private _runAction(): void {
		Promise.resolve(this._action.run()).catch(onUnexpectedError);
	}
}

/**
 * Keeps the first leaf for each id so a duplicate id can never map two
 * rows onto one reused element.
 */
function distinctById(leaves: readonly ICustomizationLeaf[]): ICustomizationLeaf[] {
	const seen = new Set<string>();
	return leaves.filter(leaf => {
		if (seen.has(leaf.id)) {
			return false;
		}
		seen.add(leaf.id);
		return true;
	});
}
