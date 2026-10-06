'use client';

/**
 * CollateralGuard Console — testing dashboard for the CollateralGuard
 * Intelligent Contract (v5).
 *
 * SETUP
 *   1. npm install genlayer-js
 *   2. Deploy CollateralGuard_v5.py via GenLayer Studio to Testnet Bradbury.
 *   3. Set NEXT_PUBLIC_GUARD_ADDRESS in .env.local, or edit the fallback
 *      address below.
 *
 * DESIGN NOTES
 *   This is a deliberate rewrite, not a patch of the earlier version. Every
 *   read comes from a single refreshAll() call straight after any write —
 *   there is no local optimistic merging of contract state, which is what
 *   produced the "old position disappears" bug previously. One source of
 *   truth, re-fetched every time, is slower but cannot drift out of sync.
 *
 *   All contract calls go through genlayer-js (the official SDK) — no
 *   hand-rolled calldata encoding.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';

declare global {
  interface Window {
    ethereum?: any;
  }
}

/** Derived directly from genlayer-js's own writeContract signature, rather
 * than guessing the exported type name for its calldata arg/value types —
 * this stays correct even if genlayer-js renames those types internally. */
type WriteContractParams = Parameters<ReturnType<typeof createClient>['writeContract']>[0];
type WriteArgs = WriteContractParams['args'];
type WriteValue = WriteContractParams['value'];

/* ───────────────────────────── configuration ───────────────────────────── */

const CONTRACT_ADDRESS = (
  process.env.NEXT_PUBLIC_GUARD_ADDRESS ?? '0xaCBd7A2861E5f41276F17ffCF0881906798988C4'
).toLowerCase() as `0x${string}`;

          <p className="mt-0.5 text-xs text-[#83888f]">
            {position.collateral_amount} {position.collateral_asset} vs {position.debt_amount} {position.debt_asset}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[position.status]}`}>
          {position.status}
        </span>
      </div>
      <p className="mt-2 text-xs text-[#83888f]">{position.last_message}</p>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onCheck}
          disabled={!!pending || position.locked}
          className="btn-secondary"
          title={position.locked ? 'Locked — owner must resume this account first' : undefined}
        >
          {checking ? 'Checking…' : 'Run check'}
        </button>
        {position.locked && isOwner && (
          <button onClick={onResume} disabled={!!pending} className="btn-secondary">
            {resuming ? 'Resuming…' : 'Resume account'}
          </button>
        )}
        {position.locked && !isOwner && (
          <span className="text-xs text-[#83888f]">Locked — awaiting owner resume</span>
        )}
      </div>
    </div>
  );
}
