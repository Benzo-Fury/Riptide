import { useEffect, useState } from "react";
import type { TorrentSummary } from "../../shared/types";
import { actions } from "../lib/actions";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Fields";
import { Dialog } from "../components/Dialog";

interface RemoveDialogProps {
	/** The torrents to remove; empty when closed. */
	torrents: TorrentSummary[];
	/** Start with "delete files" ticked (from "Remove with files"). */
	withFiles?: boolean;
	onClose: () => void;
}

/** Confirms removing torrents, and whether their downloaded files go too. */
export function RemoveDialog({ torrents, withFiles = false, onClose }: RemoveDialogProps) {
	const [deleteFiles, setDeleteFiles] = useState(withFiles);
	useEffect(() => setDeleteFiles(withFiles), [torrents, withFiles]);

	const n = torrents.length;
	const shown = torrents.slice(0, 3);
	const remove = () => {
		actions.remove(
			torrents.map((t) => t.hash),
			deleteFiles,
		);
		onClose();
	};

	return (
		<Dialog
			open={n > 0}
			title={n === 1 ? "Remove torrent" : `Remove ${n} torrents`}
			onClose={onClose}
			width={480}
			footer={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="danger" onClick={remove} data-autofocus>
						{deleteFiles ? "Remove and delete files" : "Remove"}
					</Button>
				</>
			}
		>
			<div className="remove">
				<ul className="remove__names">
					{shown.map((t) => (
						<li key={t.hash} className="ellipsis">
							{t.name}
						</li>
					))}
					{n > shown.length && <li className="muted">and {n - shown.length} more</li>}
				</ul>
				<Checkbox checked={deleteFiles} onChange={setDeleteFiles} label="Also delete the downloaded files" />
				<p className="muted remove__note">{deleteFiles ? "The files go for good: they aren't moved to the Bin." : "The files stay where they are."}</p>
			</div>
		</Dialog>
	);
}
