/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/customizationsTree.css';
import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IMenu, IMenuService, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Menus } from '../../../browser/menus.js';
import { CustomizationCategoryNode, ICustomizationsTreeHost, ICustomizationsTreeNode } from './customizationsCategoryNode.js';
import { findCustomizationItemConfig } from './customizationsToolbar.contribution.js';
import { CustomizationsTreeDataSource } from './customizationsTreeItems.js';

const $ = DOM.$;

/** JSON array of category action ids the user has expanded in place. */
const EXPANDED_CATEGORIES_STORAGE_KEY = 'agentSessions.customizationsShortcuts.expandedCategories';

/**
 * The row that owned focus before the categories were rebuilt, by id, so the
 * same row (or its category) can take focus back afterwards.
 */
interface ITreeFocus {
	readonly categoryId: string;
	readonly leafId: string | undefined;
}

/**
 * The expandable customizations tree shown in the sessions sidebar. Category
 * rows come from the `Menus.SidebarCustomizations` menu (so harness gating
 * and ordering stay in one place); each expandable category renders its
 * items inline beneath it. Focus moves between rows with the arrow keys,
 * Right/Left expand and collapse, Enter/Space activate.
 *
 * The tree is a single Tab stop (roving tabindex): only the row that last
 * had focus is tabbable, initially the first category.
 */
export class CustomizationsTree extends Disposable implements ICustomizationsTreeHost {

	readonly element: HTMLElement;

	private readonly _onDidChangeContentHeight = this._register(new Emitter<void>());
	readonly onDidChangeContentHeight = this._onDidChangeContentHeight.event;

	private readonly _menu: IMenu;
	private readonly _categories = this._register(new DisposableStore());
	private readonly _nodes = new WeakMap<HTMLElement, ICustomizationsTreeNode>();
	private readonly _dataSource: CustomizationsTreeDataSource;
	private _categoryNodes: readonly CustomizationCategoryNode[] = [];
	private _expandedCategories: ReadonlySet<string>;
	/** The one row in the Tab sequence. */
	private _tabbableRow: HTMLElement | undefined;

	constructor(
		container: HTMLElement,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly _storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._expandedCategories = this._readExpandedCategories();
		this._dataSource = this._instantiationService.createInstance(CustomizationsTreeDataSource);

		this.element = DOM.append(container, $('.customizations-tree', { role: 'tree', 'aria-label': localize('customizationsTree', "Customizations") }));
		this._register(DOM.addDisposableListener(this.element, DOM.EventType.KEY_DOWN, e => this._onKeyDown(e)));
		// Whatever row takes focus (by key, click or programmatically) becomes
		// the tree's Tab stop.
		this._register(DOM.addDisposableListener(this.element, DOM.EventType.FOCUS_IN, e => {
			const row = this._resolveRow(e.target);
			if (row) {
				this._setTabbable(row);
			}
		}));

		this._menu = this._register(menuService.createMenu(Menus.SidebarCustomizations, contextKeyService));
		this._register(this._menu.onDidChange(() => this._renderCategories()));
		this._renderCategories();
	}

	focus(): void {
		this._currentRow()?.focus();
	}

	// --- ICustomizationsTreeHost

	isExpanded(categoryId: string): boolean {
		return this._expandedCategories.has(categoryId);
	}

	setExpanded(categoryId: string, expanded: boolean): void {
		const next = new Set(this._expandedCategories);
		if (expanded) {
			next.add(categoryId);
		} else {
			next.delete(categoryId);
		}
		this._expandedCategories = next;
		this._storageService.store(EXPANDED_CATEGORIES_STORAGE_KEY, JSON.stringify([...next]), StorageScope.PROFILE, StorageTarget.USER);
	}

	registerNode(element: HTMLElement, node: ICustomizationsTreeNode): void {
		this._nodes.set(element, node);
	}

	notifyContentHeightChanged(): void {
		// Rows may have come or gone; make sure one of them is still tabbable.
		this._ensureTabbable();
		this._onDidChangeContentHeight.fire();
	}

	// --- rendering

	private _renderCategories(): void {
		const focus = this._captureFocus();
		this._categories.clear();
		DOM.clearNode(this.element);
		this._categoryNodes = [];
		const categoryNodes: CustomizationCategoryNode[] = [];
		for (const [, actions] of this._menu.getActions()) {
			for (const action of actions) {
				if (action instanceof SubmenuItemAction) {
					continue;
				}
				categoryNodes.push(this._categories.add(this._instantiationService.createInstance(CustomizationCategoryNode, this.element, action, findCustomizationItemConfig(action.id), this, this._dataSource)));
			}
		}
		this._categoryNodes = categoryNodes;
		this._ensureTabbable();
		this._restoreFocus(focus);
		this._onDidChangeContentHeight.fire();
	}

	private _readExpandedCategories(): ReadonlySet<string> {
		const raw = this._storageService.get(EXPANDED_CATEGORIES_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return new Set();
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
		} catch {
			return new Set();
		}
	}

	// --- focus bookkeeping

	private _captureFocus(): ITreeFocus | undefined {
		const active = DOM.getActiveElement();
		if (!active || !DOM.isAncestor(active, this.element)) {
			return undefined;
		}
		const category = this._categoryNodes.find(node => DOM.isAncestor(active, node.element));
		return category ? { categoryId: category.id, leafId: category.focusedLeafId() } : undefined;
	}

	private _restoreFocus(focus: ITreeFocus | undefined): void {
		if (!focus) {
			return;
		}
		const category = this._categoryNodes.find(node => node.id === focus.categoryId) ?? this._categoryNodes.at(0);
		const leaf = focus.leafId !== undefined ? category?.leafElement(focus.leafId) : undefined;
		(leaf ?? category?.element)?.focus();
	}

	/** The row Tab lands on: the last focused row while it is still rendered, else the first. */
	private _currentRow(): HTMLElement | undefined {
		return this._tabbableRow && DOM.isAncestor(this._tabbableRow, this.element)
			? this._tabbableRow
			: this._visibleNodes().at(0);
	}

	private _setTabbable(row: HTMLElement): void {
		if (this._tabbableRow === row) {
			return;
		}
		this._tabbableRow?.setAttribute('tabindex', '-1');
		row.setAttribute('tabindex', '0');
		this._tabbableRow = row;
	}

	private _ensureTabbable(): void {
		const row = this._currentRow();
		if (row) {
			this._setTabbable(row);
		}
	}

	// --- keyboard navigation

	private _visibleNodes(): HTMLElement[] {
		// Collapsed categories report no children, so this is exactly the set
		// of rows currently in the DOM, in document order.
		return this._categoryNodes.flatMap(node => node.focusableElements);
	}

	/**
	 * Walks up from an event target to the registered row that contains it
	 * (a key press may originate on a row's chevron button).
	 */
	private _resolveRow(target: EventTarget | null): HTMLElement | undefined {
		let element = DOM.isHTMLElement(target) ? target : null;
		while (element && element !== this.element) {
			if (this._nodes.has(element)) {
				return element;
			}
			element = element.parentElement;
		}
		return undefined;
	}

	private _onKeyDown(e: KeyboardEvent): void {
		const target = this._resolveRow(e.target);
		const node = target ? this._nodes.get(target) : undefined;
		if (!target || !node) {
			return;
		}
		if (this._handleKey(new StandardKeyboardEvent(e), target, node)) {
			DOM.EventHelper.stop(e, true);
		}
	}

	private _handleKey(event: StandardKeyboardEvent, target: HTMLElement, node: ICustomizationsTreeNode): boolean {
		if (event.equals(KeyCode.DownArrow)) {
			return this._focusSibling(target, 1);
		}
		if (event.equals(KeyCode.UpArrow)) {
			return this._focusSibling(target, -1);
		}
		if (event.equals(KeyCode.Home)) {
			return this._focusAt(0);
		}
		if (event.equals(KeyCode.End)) {
			return this._focusAt(-1);
		}
		if (event.equals(KeyCode.RightArrow)) {
			return this._expandOrEnter(node);
		}
		if (event.equals(KeyCode.LeftArrow)) {
			return this._collapseOrLeave(node);
		}
		if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
			// A focused chevron button handles these natively.
			if (DOM.isHTMLButtonElement(event.target)) {
				return false;
			}
			node.activate();
			return true;
		}
		return false;
	}

	private _expandOrEnter(node: ICustomizationsTreeNode): boolean {
		if (!node.expandable) {
			return false;
		}
		if (!node.expandable.isExpanded()) {
			node.expandable.setExpanded(true);
			return true;
		}
		node.expandable.firstLeaf()?.focus();
		return true;
	}

	private _collapseOrLeave(node: ICustomizationsTreeNode): boolean {
		if (node.expandable?.isExpanded()) {
			node.expandable.setExpanded(false);
			return true;
		}
		if (node.parent) {
			node.parent.focus();
			return true;
		}
		return false;
	}

	private _focusSibling(target: HTMLElement, delta: number): boolean {
		const nodes = this._visibleNodes();
		const index = nodes.indexOf(target);
		if (index < 0) {
			return false;
		}
		nodes.at(index + delta)?.focus();
		return true;
	}

	private _focusAt(index: number): boolean {
		this._visibleNodes().at(index)?.focus();
		return true;
	}
}
