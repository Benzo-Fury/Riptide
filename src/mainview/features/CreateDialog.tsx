import { useEffect, useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import type { CreateResult } from "../../shared/types";
import { call } from "../lib/bridge";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Select, TextField, Toggle } from "../components/Fields";
import { ProgressBar } from "../components/ProgressBar";
import { toast } from "../components/Toasts";

/** Piece sizes offered, in KiB; "auto" lets the engine choose from the content's size. */
const PIECE_SIZES = ["auto", "16", "32", "64", "128", "256", "512", "1024", "2048", "4096", "8192", "16384"] as const;
type PieceSize = (typeof PIECE_SIZES)[number];

const pieceLabel = (s: PieceSize) => (s === "auto" ? "Chosen from the size" : Number(s) >= 1024 ? `${Number(s) / 1024} MiB` : `${s} KiB`);

interface CreateDialogProps {
	open: boolean;
	onClose: () => void;
}

/** Makes a .torrent from a file or folder, and optionally starts seeding it at once. */
export function CreateDialog({ open, onClose }: CreateDialogProps) {
	const [path, setPath] = useState("");
	const [trackers, setTrackers] = useState("");
	const [comment, setComment] = useState("");
	const [piece, setPiece] = useState<PieceSize>("auto");
	const [isPrivate, setPrivate] = useState(false);
	const [seed, setSeed] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<CreateResult | null>(null);

	// Start fresh each time it opens
	useEffect(() => {
		if (!open) return;
		setResult(null);
		setError(null);
		setBusy(false);
	}, [open]);

	const choose = async () => {
		const picked = await call("pickContent").catch(() => null);
		if (picked) setPath(picked);
	};

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await call("create", {
				path: path.trim(),
				trackers: trackers.split("\n").map((t) => t.trim()).filter(Boolean),
				private: isPrivate,
				comment: comment.trim() || undefined,
				pieceKb: piece === "auto" ? undefined : Number(piece),
				seed,
			});
			setResult(r);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const copyMagnet = async () => {
		if (!result) return;
		await call("writeClipboard", { text: result.magnet });
		toast("Magnet link copied.", "success");
	};

	// The finished state replaces the form
	if (result) {
		return (
			<Dialog
				open={open}
				title="Torrent created"
				onClose={onClose}
				footer={
					<>
						<Button icon={<FolderOpen size={14} strokeWidth={1.5} />} onClick={() => call("revealPath", { path: result.out })}>
							Show file
						</Button>
						<Button variant="primary" icon={<Copy size={14} strokeWidth={1.5} />} onClick={copyMagnet}>
							Copy magnet link
						</Button>
					</>
				}
			>
				<div className="create-done">
					<p className="create-done__path selectable">{result.out}</p>
					<p className="muted">{seed ? "Seeding now, straight from your files." : "Add it whenever you want to share it."}</p>
				</div>
			</Dialog>
		);
	}

	return (
		<Dialog
			open={open}
			title="Create torrent"
			onClose={busy ? () => {} : onClose}
			width={600}
			footerNote={error ? <span className="is-error">{error}</span> : busy ? "Hashing every piece. Big folders take a while." : null}
			footer={
				<>
					<Button onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="primary" onClick={create} disabled={busy || !path.trim()}>
						{busy ? "Creating…" : "Create"}
					</Button>
				</>
			}
		>
			<div className="create">
				<TextField
					label="File or folder to share"
					value={path}
					onChange={setPath}
					placeholder="/Users/you/Album"
					suffix={
						<Button variant="ghost" icon={<FolderOpen size={14} strokeWidth={1.5} />} onClick={choose}>
							Choose
						</Button>
					}
				/>
				<TextField label="Trackers, one per line" multiline rows={3} value={trackers} onChange={setTrackers} placeholder="udp://tracker.example.org:1337/announce" hint="Optional: without trackers, peers find it through the DHT." />
				<div className="create__row">
					<Select label="Piece size" value={piece} onChange={setPiece} options={PIECE_SIZES.map((s) => ({ value: s, label: pieceLabel(s) }))} />
					<TextField label="Comment" value={comment} onChange={setComment} placeholder="Optional" />
				</div>
				<Toggle label="Private" description="Peers come only from its trackers: no DHT, no peer exchange." checked={isPrivate} onChange={setPrivate} />
				<Toggle label="Start seeding" description="Shares the files right away, without copying them." checked={seed} onChange={setSeed} />
				{busy && <ProgressBar value={0} indeterminate label="Creating" />}
			</div>
		</Dialog>
	);
}
