/*******************************************************************************
 * @license
 * Copyright (c) 2013 IBM Corporation and others. 
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 * 
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/
/*global define URL*/
/*jslint browser:true sub:true*/
define([
	'i18n!orion/edit/nls/messages',
	'orion/objects',
	'orion/webui/littlelib',
	'orion/explorers/explorer-table',
	'orion/explorers/navigatorRenderer',
	'orion/explorers/explorerNavHandler',
	'orion/keyBinding',
	'orion/fileCommands',
	'orion/extensionCommands',
	'orion/selection',
	'orion/URITemplate',
	'orion/PageUtil',
	'orion/Deferred',
	'orion/webui/contextmenu'
], function(
	messages, objects, lib, mExplorer, mNavigatorRenderer, mExplorerNavHandler, mKeyBinding,
	FileCommands, ExtensionCommands, Selection, URITemplate, PageUtil, Deferred, mContextMenu
) {
	var FileExplorer = mExplorer.FileExplorer;
	var KeyBinding = mKeyBinding.KeyBinding;
	var NavigatorRenderer = mNavigatorRenderer.NavigatorRenderer;

	var uriTemplate = new URITemplate("#{,resource,params*}"); //$NON-NLS-0$
	
	/**
	 * @class orion.sidebar.CommonNavExplorer
	 * @extends orion.explorers.FileExplorer
	 */
	function CommonNavExplorer(params) {
		params.setFocus = false;   // do not steal focus on load
		params.cachePrefix = null; // do not persist table state
		params.modelEventDispatcher = FileCommands.getModelEventDispatcher();
		params.dragAndDrop = FileCommands.uploadFile;
		FileExplorer.apply(this, arguments);
		this.commandRegistry = params.commandRegistry;
		this.editorInputManager = params.editorInputManager;
		this.progressService = params.progressService;
		var sidebarNavInputManager = this.sidebarNavInputManager = params.sidebarNavInputManager;
		this.toolbarNode = params.toolbarNode;

		this.fileActionsScope = "fileActions"; //$NON-NLS-0$
		this.editActionsScope = "editActions"; //$NON-NLS-0$
		this.viewActionsScope = "viewActions"; //$NON-NLS-0$
		this.toolsActionsScope = "toolsActions"; //$NON-NLS-0$
		this.additionalActionsScope = "extraActions"; //$NON-NLS-0$
		
		this._parentNode = lib.node(this.parentId);
		this._sidebarContextMenuNode = document.createElement("ul"); //$NON-NLS-0$
		this._sidebarContextMenuNode.className = "dropdownMenu"; //$NON-NLS-0$
		this._sidebarContextMenuNode.setAttribute("role", "menu"); //$NON-NLS-1$ //$NON-NLS-0$
		this._sidebarContextMenuNode.id = this.parentId + "ContextMenu"; //$NON-NLS-0$
		
		this._parentNode.parentNode.insertBefore(this._sidebarContextMenuNode, this._parentNode);
		
		this.contextMenuActionsScope = this._sidebarContextMenuNode.id + "commonNavContextMenu"; //$NON-NLS-0$

		this.treeRoot = {}; // Needed by FileExplorer.prototype.loadResourceList
		var _self = this;
		this.editorInputListener = function(event) {
			_self.reveal(event.metadata);
		};
		this.editorInputManager.addEventListener("InputChanged", this.editorInputListener); //$NON-NLS-0$
		if (sidebarNavInputManager) {
			sidebarNavInputManager.reveal = function(metadata) {
				_self.reveal(metadata);
			};
		}
		var dispatcher = this.modelEventDispatcher;
		var onChange = this._modelListener = this.onFileModelChange.bind(this);
		["move", "delete"].forEach(function(type) { //$NON-NLS-1$ //$NON-NLS-0$
			dispatcher.addEventListener(type, onChange);
		});
		this.selection = new Selection.Selection(this.registry, "commonNavFileSelection"); //$NON-NLS-0$
		this._selectionListener = function(event) { //$NON-NLS-0$
			_self.updateCommands(event.selections);
			if (sidebarNavInputManager) {
				_self.sidebarNavInputManager.dispatchEvent(event);
			}
		};
		this.selection.addEventListener("selectionChanged", this._selectionListener); //$NON-NLS-0$
		this.commandsRegistered = this.registerCommands();
		
		this._createContextMenu();
	}
	CommonNavExplorer.prototype = Object.create(FileExplorer.prototype);
	objects.mixin(CommonNavExplorer.prototype, /** @lends orion.sidebar.CommonNavExplorer.prototype */ {
		onLinkClick: function(event) {
			FileExplorer.prototype.onLinkClick.call(this, event);
			//Redispatch to nav input manager
			this.sidebarNavInputManager.dispatchEvent(event);
			var navHandler = this.getNavHandler();
			if (!navHandler || !event.item.Directory) {
				return;
			}
			var folder = event.item;
			navHandler.cursorOn(folder);
			navHandler.setSelection(folder, false);
			// now toggle its expand/collapse state
			var curModel = navHandler._modelIterator.cursor();
			if (navHandler.isExpandable(curModel)){
				if (!navHandler.isExpanded(curModel)){
					this.myTree.expand(curModel);
				} else {
					this.myTree.collapse(curModel);
				}
			}
		},
		onModelCreate: function(event) {
			return FileExplorer.prototype.onModelCreate.call(this, event).then(function () {
				this.sidebarNavInputManager.dispatchEvent(event);
			}.bind(this));
		},
		onFileModelChange: function(event) {
			var oldValue = event.oldValue, newValue = event.newValue;
			// Detect if we moved/renamed/deleted the current file being edited, or an ancestor thereof.
			var editorFile = this.editorInputManager.getFileMetadata();
			if (!editorFile) {
				return;
			}
			var affectedAncestor;
			[editorFile].concat(editorFile.Parents || []).some(function(ancestor) {
				if (oldValue.Location === ancestor.Location) {
					affectedAncestor = oldValue;
					return true;
				}
				return false;
			});
			if (affectedAncestor) {
				var newInput;
				if (affectedAncestor.Location === editorFile.Location) {
					// Current file was the target, see if we know its new name
					newInput = (newValue && newValue.ChildrenLocation) || (newValue && newValue.ContentLocation) || (newValue && newValue.Location) || null;
				} else {
					newInput = null;
				}
				this.sidebarNavInputManager.dispatchEvent({
					type: "editorInputMoved", //$NON-NLS-0$
					parent: this.treeRoot.ChildrenLocation,
					newInput: newInput
				});
			}
		},
		createActionSections: function() {
			var _self = this;
			// Create some elements that we can hang actions on. Ideally we'd have just 1, but the
			// CommandRegistry seems to require dropdowns to have their own element.
			[].forEach(function(id) {
				if (!_self[id]) {
					var elem = document.createElement("ul"); //$NON-NLS-0$
					elem.id = id;
					elem.classList.add("commandList"); //$NON-NLS-0$
					elem.classList.add("layoutLeft"); //$NON-NLS-0$
					elem.classList.add("pageActions"); //$NON-NLS-0$
					_self.toolbarNode.appendChild(elem);
					_self[id] = elem;
				}
			});
		},
		
		destroy: function() {
			var _self = this;
			var dispatcher = this.modelEventDispatcher;
			["move", "delete"].forEach(function(type) { //$NON-NLS-1$ //$NON-NLS-0$
				dispatcher.removeEventListener(type, _self._modelListener);
			});
			FileExplorer.prototype.destroy.call(this);
			[].forEach(function(id) {
				delete _self[id];
			});
			this.editorInputManager.removeEventListener("InputChanged", this.editorInputListener); //$NON-NLS-0$
			this.selection.removeEventListener("selectionChanged", this._selectionListener); //$NON-NLS-0$
			
			if (this._contextMenu) {
				this._contextMenu.destroy();
				this._contextMenu = null;
			}
			if (this._sidebarContextMenuNode) {
				this._parentNode.parentNode.removeChild(this._sidebarContextMenuNode);
				this._sidebarContextMenuNode = null;
			}
		},
		display: function(root, force) {
			return this.loadRoot(root, force).then(function(){
				this.updateCommands();
				return this.reveal(this.editorInputManager.getFileMetadata());
			}.bind(this));	
		},
		/**
		 * Loads the given children location as the root.
		 * @param {String|Object} childrentLocation The childrenLocation or an object with a ChildrenLocation field.
		 * @returns {orion.Promise}
		 */
		loadRoot: function(childrenLocation, force) {
			childrenLocation = (childrenLocation && childrenLocation.ChildrenLocation) || childrenLocation || ""; //$NON-NLS-0$
			return this.commandsRegistered.then(function() {
				if (childrenLocation && typeof childrenLocation === "object") { //$NON-NLS-0$
					return this.load(childrenLocation);
				} else {
					return this.loadResourceList(childrenLocation, force);
				}
			}.bind(this));
		},
		scope: function(childrenLocation) {
			childrenLocation = (childrenLocation && childrenLocation.ChildrenLocation) || childrenLocation || ""; //$NON-NLS-0$
			var params = PageUtil.matchResourceParameters();
			var resource = params.resource;
			delete params.resource;
			if (childrenLocation) {
				if (params.navigate === childrenLocation) {
					return;
				}
				params.navigate = childrenLocation;
			} else {
				delete params.navigate;
			}
			window.location.href = uriTemplate.expand({resource: resource, params: params});
		},
		scopeUp: function() {
			var navigate;
			var root = this.treeRoot;
			var parent = root.Parents && root.Parents[0];
			if (parent) {
				navigate = parent.ChildrenLocation;
			} else {
				navigate = this.fileClient.fileServiceRootURL(root.Location);
			}
			this.scope(navigate);
		},
		scopeDown: function(item) {
			this.scope(item.ChildrenLocation);
		},
		// Returns a deferred that completes once file command extensions have been processed
		registerCommands: function() {
			var commandRegistry = this.commandRegistry, fileClient = this.fileClient, serviceRegistry = this.registry;
			var fileActionsScope = this.fileActionsScope;
			var editActionsScope = this.editActionsScope;
			var viewActionsScope = this.viewActionsScope;
			var contextMenuActionsScope = this.contextMenuActionsScope;
			
			commandRegistry.registerSelectionService(fileActionsScope, this.selection);
			commandRegistry.registerSelectionService(editActionsScope, this.selection);
			commandRegistry.registerSelectionService(viewActionsScope, this.selection);
			commandRegistry.registerSelectionService(contextMenuActionsScope, this.selection);
		
			var renameBinding = new KeyBinding(113); // F2
			var delBinding = new KeyBinding(46); // Delete
			var cutBinding = new KeyBinding('x', true); /* Ctrl+X */ //$NON-NLS-0$
			var copySelections = new KeyBinding('c', true); /* Ctrl+C */ //$NON-NLS-0$
			var pasteSelections = new KeyBinding('v', true); /* Ctrl+V */ //$NON-NLS-0$
			var upFolder = new KeyBinding(38, false, false, true); /* Alt+UpArrow */
			var downFolder = new KeyBinding(40, false, false, true); /* Alt+DownArrow */
			downFolder.domScope = upFolder.domScope = pasteSelections.domScope = copySelections.domScope = delBinding.domScope = renameBinding.domScope = "sidebar"; //$NON-NLS-0$
			downFolder.scopeName = upFolder.scopeName = pasteSelections.scopeName = copySelections.scopeName = delBinding.scopeName = renameBinding.scopeName = messages.Navigator; //$NON-NLS-0$

			// New actions
			commandRegistry.registerCommandContribution(fileActionsScope, "eclipse.newFile", 1, "orion.menuBarFileGroup/orion.newContentGroup/orion.new.default"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(fileActionsScope, "eclipse.newFolder", 2, "orion.menuBarFileGroup/orion.newContentGroup/orion.new.default", false, null/*, new mCommandRegistry.URLBinding("newFolder", "name")*/); //$NON-NLS-3$ //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(fileActionsScope, "orion.new.project", 3, "orion.menuBarFileGroup/orion.newContentGroup/orion.new.default"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(fileActionsScope, "orion.new.linkProject", 4, "orion.menuBarFileGroup/orion.newContentGroup/orion.new.default"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$

			// Import actions
			commandRegistry.registerCommandContribution(fileActionsScope, "orion.import", 1, "orion.menuBarFileGroup/orion.importGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(fileActionsScope, "orion.importZipURL", 2, "orion.menuBarFileGroup/orion.importGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(fileActionsScope, "orion.importSFTP", 3, "orion.menuBarFileGroup/orion.importGroup"); //$NON-NLS-1$ //$NON-NLS-0$

			// Export actions
			commandRegistry.registerCommandContribution(fileActionsScope, "eclipse.downloadFile", 1, "orion.menuBarFileGroup/orion.exportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(fileActionsScope, "eclipse.exportSFTPCommand", 2, "orion.menuBarFileGroup/orion.exportGroup"); //$NON-NLS-1$ //$NON-NLS-0$

			// Edit actions
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.renameResource", 1, "orion.menuBarEditGroup/orion.renameGroup", false, renameBinding); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.cut", 2, "orion.menuBarEditGroup/orion.clipboardGroup", false, cutBinding); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.copySelections", 3, "orion.menuBarEditGroup/orion.clipboardGroup", false, copySelections); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.pasteSelections", 4, "orion.menuBarEditGroup/orion.clipboardGroup", false, pasteSelections); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.deleteFile", 5, "orion.menuBarEditGroup/orion.deleteGroup", false, delBinding); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.compareWith", 6, "orion.menuBarEditGroup/orion.compareGroup");  //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(editActionsScope, "eclipse.compareWithEachOther", 7, "orion.menuBarEditGroup/orion.compareGroup");  //$NON-NLS-1$ //$NON-NLS-0$
			
			// View actions
			commandRegistry.registerCommandContribution(viewActionsScope, "eclipse.downFolder", 0, "orion.menuBarViewGroup", false, downFolder); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(viewActionsScope, "eclipse.upFolder", 1, "orion.menuBarViewGroup", false, upFolder); //$NON-NLS-1$ //$NON-NLS-0$
			
			// context menu groups
			commandRegistry.addCommandGroup(contextMenuActionsScope, "orion.commonNavContextMenuEditGroup", 100, null, null, null, null, null, "dropdownSelection"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.addCommandGroup(contextMenuActionsScope, "orion.New", 0, messages["New"], "orion.commonNavContextMenuEditGroup", null, null, null, "dropdownSelection"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.addCommandGroup(contextMenuActionsScope, "orion.OpenWith", 1001, messages["OpenWith"], "orion.commonNavContextMenuEditGroup", null, null, null, "dropdownSelection"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.addCommandGroup(contextMenuActionsScope, "orion.Extensions", 1002, messages["Extensions"], "orion.commonNavContextMenuEditGroup", null, null, null, "dropdownSelection"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.addCommandGroup(contextMenuActionsScope, "orion.ImportGroup", 1003, messages["Import"], "orion.commonNavContextMenuEditGroup", null, null, null, "dropdownSelection"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$			
			commandRegistry.addCommandGroup(contextMenuActionsScope, "orion.ExportGroup", 1004, messages["Export"], "orion.commonNavContextMenuEditGroup", null, null, null, "dropdownSelection"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$			


			//TODO other new contributions
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.newFile", 1, "orion.commonNavContextMenuEditGroup/orion.New"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.newFolder", 2, "orion.commonNavContextMenuEditGroup/orion.New", false, null/*, new mCommandRegistry.URLBinding("newFolder", "name")*/); //$NON-NLS-3$ //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "orion.new.project", 3, "orion.commonNavContextMenuEditGroup/orion.New"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "orion.new.linkProject", 4, "orion.commonNavContextMenuEditGroup/orion.New"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$

			// Context menu actions
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.renameResource", 1, "orion.commonNavContextMenuEditGroup", false); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.cut", 2, "orion.commonNavContextMenuEditGroup", false); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.copySelections", 3, "orion.commonNavContextMenuEditGroup", false); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.pasteSelections", 4, "orion.commonNavContextMenuEditGroup", false); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.deleteFile", 5, "orion.commonNavContextMenuEditGroup", false); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.compareWith", 6, "orion.commonNavContextMenuEditGroup");  //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.compareWithEachOther", 7, "orion.commonNavContextMenuEditGroup");  //$NON-NLS-1$ //$NON-NLS-0$
			
			// Context menu ImportExportGroup group
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "orion.import", 1, "orion.commonNavContextMenuEditGroup/orion.ImportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "orion.importZipURL", 2, "orion.commonNavContextMenuEditGroup/orion.ImportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "orion.importSFTP", 3, "orion.commonNavContextMenuEditGroup/orion.ImportGroup"); //$NON-NLS-1$ //$NON-NLS-0$

			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.downloadFile", 1, "orion.commonNavContextMenuEditGroup/orion.ExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(contextMenuActionsScope, "eclipse.exportSFTPCommand", 2, "orion.commonNavContextMenuEditGroup/orion.ExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			
			FileCommands.createFileCommands(serviceRegistry, commandRegistry, this, fileClient);
			return ExtensionCommands.createAndPlaceFileCommandsExtension(serviceRegistry, commandRegistry, viewActionsScope, 3, "orion.menuBarViewGroup", true).then(function() { //$NON-NLS-0$
				// Context menu OpenWith and Extensions group
				var openWithCommands = ExtensionCommands.getOpenWithCommands(commandRegistry);
				openWithCommands.forEach(function(command){
					commandRegistry.registerCommandContribution(contextMenuActionsScope, command.id, 1, "orion.commonNavContextMenuEditGroup/orion.OpenWith"); //$NON-NLS-0$
				});
								
				// Context menu Extensions group
				var fileCommandIds = ExtensionCommands.getFileCommandIds();
				fileCommandIds.forEach(function(commandId){
					commandRegistry.registerCommandContribution(contextMenuActionsScope, commandId, 1, "orion.commonNavContextMenuEditGroup/orion.Extensions"); //$NON-NLS-0$
				});
			}); //$NON-NLS-0$
		},
		updateCommands: function(selections) {
			this.createActionSections();
			var treeRoot = this.treeRoot, commandRegistry = this.commandRegistry;
			FileCommands.updateNavTools(this.registry, commandRegistry, this, null, [this.fileActionsScope, this.editActionsScope, this.viewActionsScope], treeRoot, true);
			commandRegistry.destroy(this.toolsActionsScope);
			commandRegistry.renderCommands(this.toolsActionsScope, this.toolsActionsScope, this.treeRoot, this, "tool"); //$NON-NLS-0$
			commandRegistry.destroy(this.additionalActionsScope);
			commandRegistry.renderCommands(this.additionalActionsScope, this.additionalActionsScope, this.selections, this, "tool"); //$NON-NLS-0$
			if (this._sidebarContextMenuNode) {
				this._populateContextMenu(this._sidebarContextMenuNode);
			}
		},
		
		_populateContextMenu: function(contextMenuNode) {
			var selectionService = this.selection;
			var selections = selectionService.getSelections();
			var items = null;
			
			this.commandRegistry.destroy(contextMenuNode); // remove previous content
			
			if (!selections || (Array.isArray(selections) && !selections.length)) {
				//no selections, use this.treeRoot to determine commands
				items = this.treeRoot;
			}
			this.commandRegistry.renderCommands(this.contextMenuActionsScope, contextMenuNode, items, this, "menu");  //$NON-NLS-0$	
		},
			
		_createContextMenu: function() {
			//function called when the context menu is triggered to set the nav selection properly
			var contextMenuTriggered = function(eventWrapper) {
				var navHandler = this.getNavHandler();
				var navDict = this.getNavDict();
				var event = eventWrapper.event;
				var item = null;
				
				if (event.target) {
					var node = event.target;
					while (this._parentNode.contains(node)) {
						if ("TR" === node.nodeName) {	//$NON-NLS-0$ //TODO this is brittle, see if a better way exists
							var rowId = node.id;
							item = navDict.getValue(rowId);
							break;
						}
						node = node.parentNode;
					}
					
					if (item && !navHandler.isDisabled(item.rowDomNode)) {
						// only modify the selection if the item that the context menu
						// was triggered on isn't already part of the selection
						var existingSels = navHandler.getSelection();
						if (-1 === existingSels.indexOf(item.model)) {
							navHandler.cursorOn(item.model, true, false, true);
							navHandler.setSelection(item.model, false, true);
						}
					} else {
						// context menu was triggered on sidebar itself,
						// clear previous selections
						this.selection.setSelections(null);
						navHandler.refreshSelection(true, true);
					}
				}
			}.bind(this);
			
			var contextMenu = new mContextMenu.ContextMenu({
				dropdown: this._sidebarContextMenuNode,
				triggerNode: this._parentNode
			});
			
			contextMenu.addEventListener("triggered", contextMenuTriggered); //$NON-NLS-0$
			
			this._contextMenu = contextMenu;
		}
	});

	function CommonNavRenderer() {
		NavigatorRenderer.apply(this, arguments);
	}
	CommonNavRenderer.prototype = Object.create(NavigatorRenderer.prototype);
	objects.mixin(CommonNavRenderer.prototype, {
		showFolderLinks: true,
		oneColumn: true,
		createFolderNode: function(folder) {
			var folderNode = NavigatorRenderer.prototype.createFolderNode.call(this, folder);
			if (this.showFolderLinks && folderNode.tagName === "A") { //$NON-NLS-0$
				folderNode.href = uriTemplate.expand({resource: folder.Location});
				folderNode.classList.add("commonNavFolder"); //$NON-NLS-0$
			} else {
				folderNode.classList.add("nav_fakelink"); //$NON-NLS-0$
			}
			return folderNode;
		},
		emptyCallback: function() {
		}
	});
	
	/**
	 * Overrides NavigatorRenderer.prototype.rowCallback
	 * @param {Element} rowElement
	 */
	CommonNavRenderer.prototype.rowCallback = function(rowElement, model) {
		NavigatorRenderer.prototype.rowCallback.call(this, rowElement, model);
		
		// Search for the model in the Cut buffer and disable it if it is found
		var cutBuffer = FileCommands.getCutBuffer();
		if (cutBuffer) {
			var matchFound = cutBuffer.some(function(cutModel) {
				return FileCommands.isEqualToOrChildOf(model, cutModel);
			});
			
			if (matchFound) {
				var navHandler = this.explorer.getNavHandler();
				navHandler.disableItem(model);
			}
		}
	};
	
	return {
		CommonNavExplorer: CommonNavExplorer,
		CommonNavRenderer: CommonNavRenderer
	};
});
