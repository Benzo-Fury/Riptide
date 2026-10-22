import { useMemo, useState } from "react";
import { ChevronRight, File, Folder } from "lucide-react";
import { formatBytes, formatPercent } from "../../shared/format";
import { Checkbox } from "../components/Fields";

/** A file as both the add dialog (no progress) and the Files tab (with progress) know it. */
export interface TreeFile {
	index: number;
	path: string;
	length: number;
	downloaded?: number;
}

interface Node {
	name: string;
	/** Folder path from the root, for expansion state. */
	key: string;
	file?: TreeFile;
	children: Node[];
	/** Every file index under this node. */
	indexes: number[];
	length: number;
	downloaded: number;
}

/** Builds a folder tree from slash-separated paths, folders first, each level sorted by name. */
function buildTree(files: TreeFile[]): Node {
	const root: Node = { name: "", key: "", children: [], indexes: [], length: 0, downloaded: 0 };
	for (const f of files) {
		const parts = f.path.split("/").filter(Boolean);
		let node = root;
		node.indexes.push(f.index);
		node.length += f.length;
		node.downloaded += f.downloaded ?? 0;
		parts.forEach((part, i) => {
			const key = parts.slice(0, i + 1).join("/");
			let child = node.children.find((c) => c.name === part && !c.file === i < parts.length - 1);
			if (!child) {
				child = { name: part, key, children: [], indexes: [], length: 0, downloaded: 0, file: i === parts.length - 1 ? f : undefined };
				node.children.push(child);
			}
			child.indexes.push(f.index);
			child.length += f.length;
			child.downloaded += f.downloaded ?? 0;
			node = child;
		});
	}
	const sort = (n: Node) => {
		n.children.sort((a, b) => (!a.file === !b.file ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.file ? 1 : -1));
		n.children.forEach(sort);
	};
	sort(root);
	return root;
}

interface FileTreeProps {
	files: TreeFile[];
	selected: Set<number>;
	onChange: (selected: Set<number>) => void;
	/** Show each file's verified share. */
	showProgress?: boolean;
	/** Double-clicking a file (to open it). */
	onOpenFile?: (file: TreeFile) => void;
}

/**
 * Files as a collapsible tree with checkboxes. Checking a folder checks everything in it; a
 * folder with some files checked shows the mixed state. Large torrents start collapsed.
 */
export function FileTree({ files, selected, onChange, showProgress, onOpenFile }: FileTreeProps) {
	const tree = useMemo(() => buildTree(files), [files]);

	// Folders start open (beyond the top level only when the torrent is small); this records the
	// ones the user flipped, so files arriving later still get sensible defaults
	const [flipped, setFlipped] = useState<Set<string>>(new Set());
	const isOpen = (key: string, depth: number) => (files.length <= 200 || depth === 0) !== flipped.has(key);

	const toggleFolder = (key: string) => {
		const next = new Set(flipped);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setFlipped(next);
	};

	const setChecked = (indexes: number[], on: boolean) => {
		const next = new Set(selected);
		for (const i of indexes) {
			if (on) next.add(i);
			else next.delete(i);
		}
		onChange(next);
	};

	// Rows for the visible part of the tree
	const rows: { node: Node; depth: number }[] = [];
	const walk = (n: Node, depth: number) => {
		for (const c of n.children) {
			rows.push({ node: c, depth });
			if (!c.file && isOpen(c.key, depth)) walk(c, depth + 1);
		}
	};
	walk(tree, 0);

	return (
		<div className="tree" role="tree" data-ui>
			{rows.map(({ node, depth }) => {
				const count = node.indexes.filter((i) => selected.has(i)).length;
				const all = count === node.indexes.length;
				const folder = !node.file;
				return (
					<div
						key={(folder ? "d:" : "f:") + node.key}
						role="treeitem"
						aria-expanded={folder ? isOpen(node.key, depth) : undefined}
						className={`tree__row ${all ? "" : count === 0 ? "is-off" : ""}`}
						style={{ paddingLeft: 8 + depth * 18 }}
						onClick={() => folder && toggleFolder(node.key)}
						onDoubleClick={() => node.file && onOpenFile?.(node.file)}
					>
						<span className={`tree__chev ${folder ? "" : "is-hidden"} ${folder && isOpen(node.key, depth) ? "is-open" : ""}`}>
							<ChevronRight size={14} strokeWidth={1.5} />
						</span>
						<Checkbox checked={all} indeterminate={!all && count > 0} onChange={(on) => setChecked(node.indexes, on)} ariaLabel={`Download ${node.name}`} />
						<span className="tree__icon">{folder ? <Folder size={14} strokeWidth={1.5} /> : <File size={14} strokeWidth={1.5} />}</span>
						<span className="tree__name ellipsis" data-tip={node.name}>
							{node.name}
						</span>
						{showProgress && <span className="tree__pct">{formatPercent(node.length ? node.downloaded / node.length : 1)}</span>}
						<span className="tree__size">{formatBytes(node.length)}</span>
					</div>
				);
			})}
		</div>
	);
}

/** Bytes of the selected files. */
export function selectedSize(files: TreeFile[], selected: Set<number>): number {
	return files.reduce((sum, f) => (selected.has(f.index) ? sum + f.length : sum), 0);
}
