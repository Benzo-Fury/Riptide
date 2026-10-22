import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";

// ---------- Text field ---------- //

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
	label?: string;
	value: string;
	onChange: (value: string) => void;
	/** A note under the field; replaced by `error` when there is one. */
	hint?: string;
	error?: string | null;
	/** Something set inside the field's right edge (a unit, a button). */
	suffix?: ReactNode;
	multiline?: boolean;
	rows?: number;
}

/** A labelled, filled input (no outline at rest, bronze focus ring). */
export function TextField({ label, value, onChange, hint, error, suffix, multiline, rows = 3, className = "", ...rest }: TextFieldProps) {
	const id = useId();
	return (
		<div className={`field ${error ? "has-error" : ""} ${className}`}>
			{label && (
				<label className="field__label" htmlFor={id}>
					{label}
				</label>
			)}
			<div className="field__control">
				{multiline ? (
					<textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...(rest as object)} />
				) : (
					<input id={id} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} autoComplete="off" {...rest} />
				)}
				{suffix && <div className="field__suffix">{suffix}</div>}
			</div>
			{(error || hint) && <p className={`field__note ${error ? "is-error" : ""}`}>{error || hint}</p>}
		</div>
	);
}

// ---------- Toggle ---------- //

interface ToggleProps {
	label: string;
	description?: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
}

/** A switch with its label and an optional explanation. */
export function Toggle({ label, description, checked, onChange, disabled }: ToggleProps) {
	const id = useId();
	return (
		<label className={`toggle ${disabled ? "is-disabled" : ""}`} htmlFor={id}>
			<span className="toggle__text">
				<span>{label}</span>
				{description && <span className="toggle__desc">{description}</span>}
			</span>
			<input id={id} type="checkbox" role="switch" className="visually-hidden" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
			<span className="toggle__track" aria-hidden>
				<span className="toggle__thumb" />
			</span>
		</label>
	);
}

// ---------- Checkbox ---------- //

interface CheckboxProps {
	checked: boolean;
	/** Some but not all children are checked. */
	indeterminate?: boolean;
	onChange: (checked: boolean) => void;
	label?: ReactNode;
	ariaLabel?: string;
	disabled?: boolean;
}

/** A small filled checkbox, with a mixed state for folders. */
export function Checkbox({ checked, indeterminate, onChange, label, ariaLabel, disabled }: CheckboxProps) {
	const state = indeterminate ? "mixed" : checked;
	return (
		<label className={`checkbox ${disabled ? "is-disabled" : ""}`} onClick={(e) => e.stopPropagation()}>
			<input
				type="checkbox"
				className="visually-hidden"
				checked={checked}
				aria-checked={state}
				aria-label={ariaLabel}
				disabled={disabled}
				onChange={(e) => onChange(indeterminate ? true : e.target.checked)}
			/>
			<span className={`checkbox__box ${checked || indeterminate ? "is-on" : ""}`} aria-hidden>
				{indeterminate ? <Minus size={12} strokeWidth={2.5} /> : checked ? <Check size={12} strokeWidth={2.5} /> : null}
			</span>
			{label && <span className="checkbox__label">{label}</span>}
		</label>
	);
}

// ---------- Select ---------- //

interface SelectProps<T extends string> {
	label?: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
	hint?: string;
}

/** A native select, filled like the text field. */
export function Select<T extends string>({ label, value, options, onChange, hint }: SelectProps<T>) {
	const id = useId();
	return (
		<div className="field">
			{label && (
				<label className="field__label" htmlFor={id}>
					{label}
				</label>
			)}
			<div className="field__control field__control--select">
				<select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
					{options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</div>
			{hint && <p className="field__note">{hint}</p>}
		</div>
	);
}
