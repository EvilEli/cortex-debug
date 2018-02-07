import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { hexFormat, binaryFormat, createMask, extractBits } from './utils';
import { NumberFormat, NodeSetting } from '../common';

interface RegisterValue {
	number: number;
	value: number;
}

export enum RecordType {
	Register,
	Field
}

export class TreeNode extends vscode.TreeItem {
	constructor(public readonly label: string, public readonly collapsibleState: vscode.TreeItemCollapsibleState, public contextValue: string, public node: BaseNode) {
		super(label, collapsibleState);

		this.command = {
			command: 'cortex-debug.registers.selectedNode',
			arguments: [node],
			title: 'Selected Node'
		};
	}
}

export class BaseNode {
	public expanded: boolean;
	protected format: NumberFormat = NumberFormat.Auto;

	constructor(public recordType: RecordType) {
		this.expanded = false;
	}

	getChildren(): BaseNode[] { return []; }
	getTreeNode(): TreeNode { return null; }
	getCopyValue(): string { return null; }
	public setFormat(format: NumberFormat) {
		this.format = format;
	}
}

export class RegisterNode extends BaseNode {
	private fields: FieldNode[];
	private currentValue: number;

	constructor(public name: string, public number: number) {
		super(RecordType.Register);
		this.name = this.name;

		if(name.toUpperCase() === 'XPSR' || name.toUpperCase() === 'CPSR') {
			this.fields = [
				new FieldNode('Negative Flag (N)', 31, 1, this),
				new FieldNode('Zero Flag (Z)', 30, 1, this),
				new FieldNode('Carry or borrow flag (C)', 29, 1, this),
				new FieldNode('Overflow Flag (V)', 28, 1, this),
				new FieldNode('Saturation Flag (Q)', 27, 1, this),
				new FieldNode('GE', 16, 4, this),
				new FieldNode('Interrupt Number', 0, 8, this),
				new FieldNode('ICI/IT', 25, 2, this),
				new FieldNode('ICI/IT', 10, 6, this),
				new FieldNode('Thumb State (T)', 24, 1, this)
			];
		}
		else if(name.toUpperCase() == 'CONTROL') {
			this.fields = [
				new FieldNode('FPCA', 2, 1, this),
				new FieldNode('SPSEL', 1, 1, this),
				new FieldNode('nPRIV', 0, 1, this)
			];
		}

		this.currentValue = 0x00;
	}

	extractBits(offset: number, width: number) : number {
		return extractBits(this.currentValue, offset, width);
	}

	getTreeNode() : TreeNode {
		let label = `${this.name} = `;
		switch (this.getFormat()) {
			case NumberFormat.Decimal:
				label += this.currentValue.toString();
				break;
			case NumberFormat.Binary:
				label += binaryFormat(this.currentValue, 32, false, true);
				break;
			default:
				label += hexFormat(this.currentValue, 8);
				break;
		}

		if(this.fields && this.fields.length > 0) {
			return new TreeNode(label, this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed, 'register', this);
		}
		else {
			return new TreeNode(label, vscode.TreeItemCollapsibleState.None, 'register', this);
		}
	}

	getChildren() : FieldNode[] {
		return this.fields;
	}

	setValue(newValue: number) {
		this.currentValue = newValue;
	}

	getCopyValue(): string {
		switch (this.getFormat()) {
			case NumberFormat.Decimal:
				return this.currentValue.toString();
			case NumberFormat.Binary:
				return binaryFormat(this.currentValue, 32);
			default:
				return hexFormat(this.currentValue, 8);
		}
	}

	getFormat(): NumberFormat {
		return this.format;
	}

	_saveState(): NodeSetting[] {
		let settings: NodeSetting[] = [];
		if (this.expanded || this.format !== NumberFormat.Auto) {
			settings.push({ node: this.name, format: this.format, expanded: this.expanded });
		}

		if (this.fields) {
			settings.push(...this.fields.map((c) => c._saveState()).filter((c) => c !== null));
		}

		return settings;
	}
}

export class FieldNode extends BaseNode {
	constructor(public name: string, private offset: number, private size: number, private register: RegisterNode) {
		super(RecordType.Field)
	}

	getTreeNode() : TreeNode {
		let value = this.register.extractBits(this.offset, this.size);
		let label = `${this.name} = `;
		switch (this.getFormat()) {
			case NumberFormat.Decimal:
				label += value.toString();
				break;
			case NumberFormat.Binary:
				label += binaryFormat(value, this.size, false, true);
				break;
			case NumberFormat.Hexidecimal:
				label += hexFormat(value, Math.ceil(this.size / 4), true);
				break;
			default:
				label += this.size >= 4 ? hexFormat(value, Math.ceil(this.size / 4), true) : binaryFormat(value, this.size, false, true);
				break;
		}

		return new TreeNode(label, vscode.TreeItemCollapsibleState.None, 'field', this);
	}

	getCopyValue() : string {
		let value = this.register.extractBits(this.offset, this.size);
		switch (this.getFormat()) {
			case NumberFormat.Decimal:
				return value.toString();
			case NumberFormat.Binary:
				return binaryFormat(value, this.size);
			case NumberFormat.Hexidecimal:
				return hexFormat(value, Math.ceil(this.size/4), true);
			default:
				return this.size >= 4 ? hexFormat(value, Math.ceil(this.size/4), true) : binaryFormat(value, this.size);
		}
	}

	getFormat(): NumberFormat {
		if (this.format === NumberFormat.Auto) { return this.register.getFormat(); }
		else { return this.format; }
	}

	_saveState(): NodeSetting {
		return this.format !== NumberFormat.Auto 
			? {
				node: `${this.register.name}.${this.name}`,
				format: this.format
			}
			: null;
	}
}

export class RegisterTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	public _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined> = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this._onDidChangeTreeData.event;

	private _registers: RegisterNode[];
	private _registerMap: { [number: number] : RegisterNode };
	private _loaded: boolean = false;

	constructor() {
		this._registers = [];
		this._registerMap = {};
	}

	refresh(): void {
		if(vscode.debug.activeDebugSession) {
			if(!this._loaded) {
				vscode.debug.activeDebugSession.customRequest('read-register-list').then(data => {
					this.createRegisters(data);
					this._refreshRegisterValues();
				});
			}
			else {
				this._refreshRegisterValues();
			}
		}
	}

	_refreshRegisterValues() {
		vscode.debug.activeDebugSession.customRequest('read-registers').then(data => {
			data.forEach(reg => {
				let number = parseInt(reg.number, 10);
				let value = parseInt(reg.value, 16);
				let regNode = this._registerMap[number];
				if(regNode) { regNode.setValue(value); }
			});
			this._onDidChangeTreeData.fire();
		});
	}

	getTreeItem(element: TreeNode) : vscode.TreeItem {
		return element.node.getTreeNode();
	}

	createRegisters(regInfo: string[]) {
		this._registerMap = {};
		this._registers = [];
		
		regInfo.forEach((reg, idx) => {
			if(reg) {
				let rn = new RegisterNode(reg, idx);
				this._registers.push(rn)
				this._registerMap[idx] = rn;
			}
		});

		this._loaded = true;

		vscode.workspace.findFiles('.vscode/.cortex-debug.registers.state.json', null, 1).then((value) => {
			if (value.length > 0) {
				let fspath = value[0].fsPath;
				let data = fs.readFileSync(fspath, 'utf8');
				let settings = JSON.parse(data);
				
				settings.forEach((s: NodeSetting) => {
					if (s.node.indexOf('.') == -1) {
						let register = this._registers.find((r) => r.name == s.node);
						if (register) {
							if (s.expanded) { register.expanded = s.expanded; }
							if (s.format) { register.setFormat(s.format); }
						}
					}
					else {
						let [regname, fieldname] = s.node.split('.');
						let register = this._registers.find((r) => r.name == regname);
						if (register) {
							let field = register.getChildren().find((f) => f.name == fieldname);
							if (field && s.format) { field.setFormat(s.format); }
						}
					}
				});
				this._onDidChangeTreeData.fire();		
			}
		}, error => {

		});

		this._onDidChangeTreeData.fire();
	}

	updateRegisterValues(values: RegisterValue[]) {
		values.forEach((reg) => {
			let node = this._registerMap[reg.number];
			node.setValue(reg.value);
		});

		this._onDidChangeTreeData.fire();
	}

	getChildren(element? : TreeNode): vscode.ProviderResult<TreeNode[]> {
		if(this._loaded && this._registers.length > 0) {
			if(element) {
				return element.node.getChildren().map(c => c.getTreeNode());
			}
			else {
				return this._registers.map(r => r.getTreeNode());
			}
		}
		else if(!this._loaded) {
			return [new TreeNode('Not in active debug session.', vscode.TreeItemCollapsibleState.None, 'message', null)];
		}
		else {
			return [];
		}
	}

	_saveState(fspath: string) {
		let state: NodeSetting[] = [];
		this._registers.forEach((r) => {
			state.push(...r._saveState());
		});

		fs.writeFileSync(fspath, JSON.stringify(state), { encoding: 'utf8', flag: 'w' });
	}

	debugSessionTerminated() {
		if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			let fspath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', '.cortex-debug.registers.state.json');
			this._saveState(fspath);
		}

		this._loaded = false;
		this._registers = [];
		this._registerMap = {};
		this._onDidChangeTreeData.fire();
	}

	debugSessionStarted() {
		this._loaded = false;
		this._registers = [];
		this._registerMap = {};
		this._onDidChangeTreeData.fire();
	}

	debugStopped() {
		this.refresh();
	}

	debugContinued() {
		
	}
}