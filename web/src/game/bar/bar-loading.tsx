import type { CSSProperties } from "react";

// While the wallet and the first contract read arrive (LC-024): the neon sign lights up letter by
// letter and a pint fills. Pure markup and CSS, so it renders on the server too.

const SIGN = "LAST CALL";

export function BarLoading({ error }: { readonly error?: string | undefined }) {
  return (
    <div className="lc-loading" role="status" aria-live="polite">
      <div className="lc-loading-sign" aria-hidden="true">
        {[...SIGN].map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the sign is static; letters repeat.
          <span key={i} style={{ "--i": i } as CSSProperties}>
            {c === " " ? " " : c}
          </span>
        ))}
      </div>
      <div className="lc-loading-pint" aria-hidden="true">
        <i className="lc-loading-fill" />
      </div>
      <p className="lc-loading-text">Loading the bar…</p>
      {error && (
        <p className="lc-loading-error" role="alert">
          Could not read the contract: {error}
        </p>
      )}
    </div>
  );
}
