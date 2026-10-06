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

const CHAIN = testnetBradbury;
const CHAIN_LABEL = 'GenLayer Bradbury Testnet';
const EXPLORER_TX = 'https://explorer-bradbury.genlayer.com/tx/';

/* ───────────────────────────────── types ────────────────────────────────── */

type Status = 'SAFE' | 'WARNING' | 'CRITICAL';

type Position = {
  address: string;
  collateral_amount: number;
  debt_amount: number;
  collateral_asset: string;
  debt_asset: string;
  status: Status;
  locked: boolean;
  last_ratio: number;
  ai_sentiment: string;
  price_source: string;
  last_message: string;
  last_checked: string;
  added_by: string;
};

type ProtocolState = {
  paused: boolean;
  threshold: number;
  owner: string;
  totalChecks: number;
};

type ActivityEvent = {
  type: string;
  account?: string;
  asset?: string;
  ratio?: number;
  status?: string;
  price_source?: string;
  message: string;
};

type ToastKind = 'info' | 'success' | 'error';
type Toast = { id: number; kind: ToastKind; text: string; txHash?: string };

/* ───────────────────────────── small helpers ────────────────────────────── */

const short = (addr: string) => (addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr);

function safeJsonParse<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** GenVM contract errors surface in different shapes depending on how far
 * the call got before reverting; this pulls the human-readable reason out
 * of whichever shape genlayer-js actually threw. */
function extractErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  const e = err as any;
  const candidates = [e?.message, e?.shortMessage, e?.cause?.message, e?.reason];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const m = c.match(/Exception:\s*([^\r\n]+)/);
      return m ? m[1].trim() : c;
    }
  }
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

const STATUS_STYLE: Record<Status, string> = {
  SAFE: 'border-[#3f5a4c] bg-[#172420] text-[#8fcbaa]',
  WARNING: 'border-[#5a4a2a] bg-[#241f12] text-[#e8a33d]',
  CRITICAL: 'border-[#5a2c33] bg-[#241419] text-[#e3788c] animate-pulse',
};

/* ═══════════════════════════════ component ══════════════════════════════ */

export default function CollateralGuardConsole() {
  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);

  const [wallet, setWallet] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null); // e.g. "check:0xabc…"

  const [protocol, setProtocol] = useState<ProtocolState | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(1);

  const [form, setForm] = useState({
    address: '',
    collateral: '',
    debt: '',
    collateralAsset: 'ETH',
    debtAsset: 'USDT',
  });
  const [thresholdInput, setThresholdInput] = useState('');

  const isOwner = useMemo(
    () => !!wallet && !!protocol && wallet.toLowerCase() === protocol.owner.toLowerCase(),
    [wallet, protocol],
  );

  const pushToast = useCallback((kind: ToastKind, text: string, txHash?: string) => {
    const id = toastId.current++;
    setToasts((prev) => [...prev.slice(-4), { id, kind, text, txHash }]);
    if (kind !== 'error') {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /* ── reads: one function, one source of truth ── */

  const refreshAll = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setLoadingAll(true);
    try {
      const [stateRaw, accountsRaw, historyRaw] = await Promise.all([
        client.readContract({ address: CONTRACT_ADDRESS, functionName: 'get_protocol_state', args: [] }),
        client.readContract({ address: CONTRACT_ADDRESS, functionName: 'get_all_accounts', args: [] }),
        client.readContract({ address: CONTRACT_ADDRESS, functionName: 'get_check_history', args: [50] }),
      ]);

      const stateJson = safeJsonParse<{ paused: boolean; threshold: string; owner: string; total_checks: string }>(
        stateRaw,
      );
      if (stateJson) {
        setProtocol({
          paused: stateJson.paused,
          threshold: Number(stateJson.threshold),
          owner: stateJson.owner,
          totalChecks: Number(stateJson.total_checks),
        });
      }

      const accountsJson = safeJsonParse<Position[]>(accountsRaw);
      setPositions(Array.isArray(accountsJson) ? accountsJson : []);

      const historyJson = safeJsonParse<ActivityEvent[]>(historyRaw);
      setActivity(Array.isArray(historyJson) ? [...historyJson].reverse() : []);
    } catch (e) {
      pushToast('error', `Could not sync contract state: ${extractErrorMessage(e)}`);
    } finally {
      setLoadingAll(false);
    }
  }, [pushToast]);

  /* ── wallet ── */

  const connectWallet = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      pushToast('error', 'MetaMask not detected — install it to use this console');
      return;
    }
    setConnecting(true);
    try {
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      const addr = accounts?.[0];
      if (!addr) return;

      const client = createClient({ chain: CHAIN, account: addr as `0x${string}`, provider: eth });
      await client.connect();
      clientRef.current = client;
      setWallet(addr);
      pushToast('success', `Connected ${short(addr)} on ${CHAIN_LABEL}`);
      await refreshAll();
    } catch (e) {
      pushToast('error', `Connection failed: ${extractErrorMessage(e)}`);
    } finally {
      setConnecting(false);
    }
  }, [pushToast, refreshAll]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    eth.request({ method: 'eth_accounts' }).then((accs: string[]) => {
      if (accs?.length) void connectWallet();
    }).catch(() => {});
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) {
        setWallet(null);
        clientRef.current = null;
      } else {
        setWallet(accs[0]);
      }
    };
    eth.on?.('accountsChanged', onAccounts);
    return () => eth.removeListener?.('accountsChanged', onAccounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── a single write helper every action below uses ── */

  const runWrite = useCallback(
    async (key: string, method: string, args: WriteArgs, successText: (out: string) => string) => {
      const client = clientRef.current;
      if (!client) {
        pushToast('error', 'Connect a wallet first');
        return;
      }
      setPendingAction(key);
      try {
        const txHash = await client.writeContract({
          address: CONTRACT_ADDRESS,
          functionName: method,
          args,
          value: 0n as WriteValue,
        });
        pushToast('info', `Transaction sent — waiting for consensus…`, txHash);

        let output = '';
        try {
          const receipt = await client.waitForTransactionReceipt({
            hash: txHash,
            status: TransactionStatus.ACCEPTED,
            retries: 25,
            interval: 4000,
          });
          output = typeof (receipt as any)?.result === 'string' ? (receipt as any).result : '';
        } catch {
          // Consensus can still be settling — state is refreshed from chain
          // below regardless, so this is not fatal.
        }

        await refreshAll();
        pushToast('success', successText(output), txHash);
      } catch (e) {
        pushToast('error', `${method} failed: ${extractErrorMessage(e)}`);
      } finally {
        setPendingAction(null);
      }
    },
    [pushToast, refreshAll],
  );

  /* ── actions ── */

  const handleAddPosition = useCallback(
    async (ev: React.FormEvent) => {
      ev.preventDefault();
      const collateral = Number(form.collateral);
      const debt = Number(form.debt);
      if (!form.address.trim() || form.address.trim().length < 8) {
        pushToast('error', 'Enter a valid account address (8+ characters)');
        return;
      }
      if (!Number.isFinite(collateral) || collateral <= 0 || !Number.isFinite(debt) || debt <= 0) {
        pushToast('error', 'Collateral and debt must be positive numbers');
        return;
      }
      await runWrite(
        'add',
        'add_monitored_account',
        [form.address.trim(), collateral, debt, form.collateralAsset, form.debtAsset],
        () => `Position added for ${short(form.address.trim())}`,
      );
      setForm((f) => ({ ...f, address: '', collateral: '', debt: '' }));
    },
    [form, runWrite, pushToast],
  );

  const handleCheck = useCallback(
    (address: string) => runWrite(`check:${address}`, 'check_and_protect', [address], (out) => out || 'Check complete'),
    [runWrite],
  );

  const handleResumeAccount = useCallback(
    (address: string) => runWrite(`resume:${address}`, 'resume_account', [address], () => `${short(address)} resumed`),
    [runWrite],
  );

  const handlePauseProtocol = useCallback(
    () => runWrite('pause', 'pause_protocol', [], () => 'Protocol paused'),
    [runWrite],
  );

  const handleResumeProtocol = useCallback(
    () => runWrite('resume-protocol', 'resume_protocol', [], () => 'Protocol resumed'),
    [runWrite],
  );

  const handleSetThreshold = useCallback(
    async (ev: React.FormEvent) => {
      ev.preventDefault();
      const value = Number(thresholdInput);
      if (!Number.isFinite(value) || value < 1 || value > 1000) {
        pushToast('error', 'Threshold must be between 1 and 1000');
        return;
      }
      await runWrite('threshold', 'set_threshold', [value], () => `Threshold set to ${value}%`);
      setThresholdInput('');
    },
    [thresholdInput, runWrite, pushToast],
  );

  /* ═══════════════════════════════ render ═══════════════════════════════ */

  return (
    <div className="min-h-screen bg-[#0d0f12] text-[#ecebe7] antialiased">
      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* header */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#262b33] pb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">CollateralGuard Console</h1>
            <p className="mt-1 text-sm text-[#83888f]">
              Live test harness for the CollateralGuard risk engine · {CHAIN_LABEL}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {wallet && (
              <span className="rounded-md border border-[#262b33] bg-[#15181d] px-3 py-1.5 font-mono text-xs text-[#83888f]">
                {short(wallet)}
                {isOwner && <span className="ml-2 text-[#e8a33d]">owner</span>}
              </span>
            )}
            <button
              onClick={connectWallet}
              disabled={connecting || !!wallet}
              className="rounded-md bg-[#e8a33d] px-4 py-1.5 text-sm font-medium text-[#0d0f12] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {wallet ? 'Connected' : connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          </div>
        </header>

        {/* protocol status bar — the thing this whole tool exists to show */}
        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Protocol status" value={protocol ? (protocol.paused ? 'Paused' : 'Active') : '—'}
            tone={protocol?.paused ? 'warn' : 'safe'} />
          <StatCard label="Liquidation threshold" value={protocol ? `${protocol.threshold}%` : '—'} />
          <StatCard label="Total checks run" value={protocol ? String(protocol.totalChecks) : '—'} />
          <StatCard label="Monitored positions" value={String(positions.length)} />
        </section>

        {/* main grid */}
        <div className="mt-8 grid gap-8 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-8">
            {/* add position */}
            <Panel title="Add a position" subtitle="Register an account for CollateralGuard to monitor.">
              <form onSubmit={handleAddPosition} className="grid grid-cols-2 gap-3">
                <Field label="Account address" className="col-span-2">
                  <input
                    value={form.address}
                    onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                    placeholder="0x…"
                    className="input"
                  />
                </Field>
                <Field label="Collateral amount">
                  <input
                    value={form.collateral}
                    onChange={(e) => setForm((f) => ({ ...f, collateral: e.target.value }))}
                    inputMode="numeric"
                    placeholder="10"
                    className="input"
                  />
                </Field>
                <Field label="Collateral asset">
                  <select
                    value={form.collateralAsset}
                    onChange={(e) => setForm((f) => ({ ...f, collateralAsset: e.target.value }))}
                    className="input"
                  >
                    <option>BTC</option>
                    <option>ETH</option>
                    <option>SOL</option>
                  </select>
                </Field>
                <Field label="Debt amount (USD)">
                  <input
                    value={form.debt}
                    onChange={(e) => setForm((f) => ({ ...f, debt: e.target.value }))}
                    inputMode="numeric"
                    placeholder="400000"
                    className="input"
                  />
                </Field>
                <Field label="Debt asset">
                  <input
                    value={form.debtAsset}
                    onChange={(e) => setForm((f) => ({ ...f, debtAsset: e.target.value }))}
                    className="input"
                  />
                </Field>
                <div className="col-span-2 pt-1">
                  <button type="submit" disabled={pendingAction === 'add' || !wallet} className="btn-primary">
                    {pendingAction === 'add' ? 'Adding…' : 'Add position'}
                  </button>
                </div>
              </form>
            </Panel>

            {/* positions table */}
            <Panel title="Monitored positions" subtitle={loadingAll ? 'Syncing…' : undefined}>
              {positions.length === 0 ? (
                <EmptyState text="No positions yet — add one above to start testing checks." />
              ) : (
                <div className="space-y-3">
                  {positions.map((p) => (
                    <PositionRow
                      key={p.address}
                      position={p}
                      pending={pendingAction}
                      isOwner={isOwner}
                      onCheck={() => handleCheck(p.address)}
                      onResume={() => handleResumeAccount(p.address)}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="space-y-8">
            {/* owner controls */}
            {isOwner && (
              <Panel title="Owner controls" subtitle="Only visible to the contract owner.">
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-md border border-[#262b33] bg-[#0d0f12] px-3 py-2.5">
                    <span className="text-sm text-[#ecebe7]">Emergency stop</span>
                    {protocol?.paused ? (
                      <button
                        onClick={handleResumeProtocol}
                        disabled={pendingAction === 'resume-protocol'}
                        className="btn-secondary"
                      >
                        {pendingAction === 'resume-protocol' ? 'Resuming…' : 'Resume protocol'}
                      </button>
                    ) : (
                      <button onClick={handlePauseProtocol} disabled={pendingAction === 'pause'} className="btn-danger">
                        {pendingAction === 'pause' ? 'Pausing…' : 'Pause protocol'}
                      </button>
                    )}
                  </div>
                  <form onSubmit={handleSetThreshold} className="flex items-end gap-2">
                    <Field label="New threshold %" className="flex-1">
                      <input
                        value={thresholdInput}
                        onChange={(e) => setThresholdInput(e.target.value)}
                        placeholder={protocol ? String(protocol.threshold) : '150'}
                        inputMode="numeric"
                        className="input"
                      />
                    </Field>
                    <button type="submit" disabled={pendingAction === 'threshold'} className="btn-secondary">
                      {pendingAction === 'threshold' ? 'Updating…' : 'Update'}
                    </button>
                  </form>
                </div>
              </Panel>
            )}

            {/* activity log */}
            <Panel title="Activity log" subtitle="Most recent on-chain events first.">
              {activity.length === 0 ? (
                <EmptyState text="No activity recorded yet." />
              ) : (
                <ul className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
                  {activity.map((a, i) => (
                    <li key={i} className="rounded-md border border-[#262b33] bg-[#0d0f12] px-3 py-2 text-xs">
                      <div className="flex items-center justify-between text-[#83888f]">
                      
