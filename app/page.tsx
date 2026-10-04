'use client';

/**
 * CollateralGuard — DeFi Risk Engine ("Cryzen" design language)
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP
 *   1. npm install genlayer-js   (official SDK — handles GenVM calldata + receipts)
 *   2. The deployed CollateralGuard address is preconfigured below. Override it
 *      at runtime in Settings (saved to localStorage) or via NEXT_PUBLIC_GUARD_ADDRESS.
 *   3. IMPORTANT: keep the address CHECKSUMMED exactly as the explorer shows it.
 *      The hosted Studio node performs a case-sensitive contract lookup.
 *
 * TRANSACTION CLASSIFICATION (verified live against Studionet getTransaction):
 *   • A reverted call still reaches ACCEPTED/FINALIZED — consensus "MAJORITY_AGREE"
 *     on an errored execution. The discriminator is leader_receipt[0].result.status:
 *     "contract_error" = reverted, otherwise executed.
 *   • The human-readable revert reason lives in genvm_result.stderr
 *     ("Exception: <reason>"); the on-chain return value of a successful write
 *     is calldata-encoded in result.raw.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';

declare global {
  interface Window {
    ethereum?: any;
  }
}

/* ─────────────────────────────── CONFIG ─────────────────────────────── */

const DEFAULT_CONTRACT_ADDRESS = '0xaCBd7A2861E5f41276F17ffCF0881906798988C4';
const ADDRESS_STORAGE_KEY = 'cg_contract_address';

const NETWORK_LABEL = 'GenLayer Studionet';
const EXPLORER_TX = 'https://explorer-studio.genlayer.com/tx/';
const THRESHOLD = 150;

const DISPLAY_PRICES: Record<string, number> = { ETH: 3200, BTC: 64000, SOL: 150, WETH: 3200 };
const ASSET_COLORS: Record<string, string> = { ETH: '#627eea', WETH: '#627eea', BTC: '#f7931a', SOL: '#14f195' };

// Live dashboard prices (display-only — on-chain verdicts use the validators' own feed)
const COINGECKO_IDS: Record<string, string> = { ETH: 'ethereum', WETH: 'ethereum', BTC: 'bitcoin', SOL: 'solana' };

type GenClient = ReturnType<typeof createClient>;

let readClientSingleton: GenClient | null = null;
function getReadClient(): GenClient {
  if (!readClientSingleton) readClientSingleton = createClient({ chain: studionet });
  return readClientSingleton;
}

/* ─────────────── GenLayer tx status/result enums (verified) ─────────── */

const STATUS_NAMES = [
  'UNINITIALIZED', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED',
  'UNDETERMINED', 'FINALIZED', 'CANCELED', 'APPEAL_COMMITTING', 'APPEAL_REVEALING',
  'READY_TO_FINALIZE', 'VALIDATORS_TIMEOUT', 'LEADER_TIMEOUT',
];
const DECIDED = new Set([5, 6, 7, 8, 12, 13]);

/* ───────────── GenVM calldata decode (for tx output payloads) ───────── */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readUleb(b: Uint8Array, idx: { v: number }): number {
  let out = 0;
  let shift = 0;
  for (;;) {
    const byte = b[idx.v++];
    out += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return out;
    shift += 7;
  }
}

function decodeCalldataValue(b: Uint8Array, idx: { v: number }): unknown {
  if (idx.v >= b.length) return null;
  const head = readUleb(b, idx);
  const tag = head & 7;
  const payload = head >> 3;
  switch (tag) {
    case 0:
      return payload === 2 ? true : payload === 1 ? false : null;
    case 1:
      return payload;
    case 4: {
      const s = new TextDecoder().decode(b.subarray(idx.v, idx.v + payload));
      idx.v += payload;
      return s;
    }
    case 5: {
      const arr: unknown[] = [];
      for (let i = 0; i < payload; i++) arr.push(decodeCalldataValue(b, idx));
      return arr;
    }
    case 6: {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < payload; i++) {
        const klen = readUleb(b, idx);
        const key = new TextDecoder().decode(b.subarray(idx.v, idx.v + klen));
        idx.v += klen;
        obj[key] = decodeCalldataValue(b, idx);
      }
      return obj;
    }
    default:
      return null;
  }
}

/** The on-chain return value of a successful write is a calldata-encoded string. */
function decodeReturnPayload(b64: string): string | undefined {
  try {
    const bytes = b64ToBytes(b64);
    const v = decodeCalldataValue(bytes, { v: 0 });
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function parseRevertReason(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  const matches = [...stderr.matchAll(/Exception:\s*([^\r\n]+)/g)];
  if (matches.length === 0) return undefined;
  return matches[matches.length - 1][1].trim();
}

/* ───────────────────────────── types/misc ───────────────────────────── */

type Position = {
  address: string;
  collateral_amount: number;
  debt_amount: number;
  collateral_asset: string;
  debt_asset: string;
  status: 'SAFE' | 'WARNING' | 'CRITICAL';
  last_ratio: number;
  ai_sentiment?: string;
  last_message: string;
  last_checked: string;
  localOnly?: boolean;
};

type ProtocolState = {
  paused: boolean;
  threshold: string | number;
  owner: string;
  total_checks: string | number;
};

type TxState = 'IN_FLIGHT' | 'EXECUTED' | 'REVERTED';

type TxRecord = {
  hash: string;
  method: string;
  argsSummary: string;
  time: string;
  state: TxState;
  chainStatus: string;
  votesAgree: number;
  votesTotal: number;
  output?: string;
  revertReason?: string;
};

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'ai';

type LogEntry = {
  id: number;
  time: string;
  level: LogLevel;
  msg: string;
  txHash?: string;
};

const short = (a: string) => (a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const fmtUSD = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const asNum = (v: string | number | undefined) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEED_POSITIONS: Position[] = [
  {
    address: '0x9ab41c7d5f3a92e0b6d18c4a77e2f9d0c5b8a3e1',
    collateral_amount: 40, debt_amount: 60000, collateral_asset: 'ETH', debt_asset: 'USDT',
    status: 'SAFE', last_ratio: 213, ai_sentiment: 'NEUTRAL',
    last_message: 'Preview row — press Run Check() to add it on-chain and run the engine',
    last_checked: 'PREVIEW', localOnly: true,
  },
  {
    address: '0x1c7d9f02e5a4b8306d91c7f5a2e8b4d0f3a6c9e2',
    collateral_amount: 10, debt_amount: 400000, collateral_asset: 'BTC', debt_asset: 'USDT',
    status: 'WARNING', last_ratio: 160, ai_sentiment: 'CATASTROPHIC',
    last_message: 'Preview row — press Run Check() to add it on-chain and run the engine',
    last_checked: 'PREVIEW', localOnly: true,
  },
  {
    address: '0xf3a902b7c4d1e6f8a5b3c2d9e7f4a1b6c8d0e3f5',
    collateral_amount: 300, debt_amount: 70000, collateral_asset: 'SOL', debt_asset: 'USDT',
    status: 'CRITICAL', last_ratio: 64, ai_sentiment: 'NEUTRAL',
    last_message: 'Preview row — press Run Check() to add it on-chain and run the engine',
    last_checked: 'PREVIEW', localOnly: true,
  },
];

const STATUS_STYLES: Record<Position['status'], string> = {
  SAFE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  WARNING: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  CRITICAL: 'bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse',
};

const TX_STATE_PILL: Record<TxState, string> = {
  IN_FLIGHT: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  EXECUTED: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  REVERTED: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
};

type Tab = 'dashboard' | 'accounts' | 'risk' | 'transactions' | 'settings';

/* ─────────────────────────── SVG components ─────────────────────────── */

function Donut({
  segments, size = 170, thickness = 22, centerLabel, centerSub,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel: string;
  centerSub: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#141d33" strokeWidth={thickness} />
        {segments.map((s) => {
          const dash = Math.max((s.value / total) * c - 2, 0);
          const el = (
            <circle
              key={s.label}
              cx={size / 2} cy={size / 2} r={r}
              fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-acc}
            />
          );
          acc += (s.value / total) * c;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-semibold text-slate-100">{centerLabel}</span>
        <span className="text-[10px] uppercase tracking-widest text-slate-500">{centerSub}</span>
      </div>
    </div>
  );
}

function HealthTimeline({ positions, threshold, prices }: { positions: Position[]; threshold: number; prices: Record<string, number> }) {
  const series = useMemo(() => {
    const coll = positions.reduce((s, p) => s + p.collateral_amount * (prices[p.collateral_asset] ?? 1000), 0);
    const debt = Math.max(1, positions.reduce((s, p) => s + p.debt_amount, 0));
    const current = Math.min(340, Math.max(90, Math.round((coll * 100) / debt)));
    let seed = 42 + positions.length * 7 + current * 13;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pts: number[] = [];
    let v = current * 0.86;
    for (let i = 0; i < 29; i++) {
      v = Math.max(95, Math.min(330, v + (rand() - 0.48) * 18));
      pts.push(v);
    }
    pts.push(current);
    return { pts, current };
  }, [positions, prices]);

  const W = 640;
  const H = 220;
  const y = (v: number) => 200 - ((v - 80) / 260) * 184;
  const x = (i: number, n: number) => 40 + (i * (W - 80)) / (n - 1);
  const line = series.pts.map((p, i) => `${x(i, series.pts.length)},${y(p)}`).join(' ');
  const area = `M ${x(0, series.pts.length)},${y(series.pts[0])} `
    + series.pts.slice(1).map((p, i) => `L ${x(i + 1, series.pts.length)},${y(p)}`).join(' ')
    + ` L ${x(series.pts.length - 1, series.pts.length)},200 L ${x(0, series.pts.length)},200 Z`;
  const lastX = x(series.pts.length - 1, series.pts.length);
  const lastY = y(series.pts[series.pts.length - 1]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
      <defs>
        <linearGradient id="healthFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[100, 200, 300].map((g) => (
        <g key={g}>
          <line x1={40} x2={W - 20} y1={y(g)} y2={y(g)} stroke="#141d33" strokeWidth="1" />
          <text x={W - 22} y={y(g) + 3} textAnchor="end" fontSize="9" fill="#334155">{g}%</text>
        </g>
      ))}
      <line x1={40} x2={W - 20} y1={y(threshold)} y2={y(threshold)} stroke="#fb7185" strokeWidth="1" strokeDasharray="5 4" opacity="0.7" />
      <text x={44} y={y(threshold) - 5} fontSize="9" fill="#fb7185">LIQ THRESHOLD {threshold}%</text>
      <path d={area} fill="url(#healthFill)" />
      <polyline points={line} fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="4" fill="#22d3ee" />
      <circle cx={lastX} cy={lastY} r="8" fill="#22d3ee" opacity="0.25" />
      <text x={lastX - 8} y={lastY - 12} textAnchor="end" fontSize="12" fontWeight="600" fill="#e2e8f0">
        {series.current}%
      </text>
      <text x={40} y={216} fontSize="9" fill="#334155">27h ago</text>
      <text x={W / 2} y={216} fontSize="9" fill="#334155" textAnchor="middle">14h ago</text>
      <text x={W - 20} y={216} fontSize="9" fill="#334155" textAnchor="end">now</text>
    </svg>
  );
}

/* ─────────────────────────── UI sub-components ──────────────────────── */

function StatusBadge({ status }: { status: Position['status'] }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function Sidebar({ wallet, tab, onTab }: { wallet: string | null; tab: Tab; onTab: (t: Tab) => void }) {
  const nav: { id: Tab; label: string; d: string }[] = [
    { id: 'dashboard', label: 'Dashboard', d: 'M3 12l9-8 9 8M5 10v10h14V10' },
    { id: 'accounts', label: 'Accounts', d: 'M4 6h16M4 12h16M4 18h10' },
    { id: 'risk', label: 'Risk Engine', d: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z' },
    { id: 'transactions', label: 'Transactions', d: 'M12 8v5l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { id: 'settings', label: 'Settings', d: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2L14 21h-4l-.5-2.6a7 7 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 015 12' },
  ];
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-[#131c30] bg-[#090e1a] md:flex">
      <div className="flex items-center gap-3 px-6 py-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="#070b14" strokeWidth="2.2">
            <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-100">CollateralGuard</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-500/80">by Cryzen</div>
        </div>
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-3">
        {nav.map((n) => (
          <button
            key={n.id}
            onClick={() => onTab(n.id)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
              tab === n.id
                ? 'border border-[#1b2b47] bg-[#0d1526] text-cyan-300'
                : 'border border-transparent text-slate-500 hover:bg-[#0d1526] hover:text-slate-300'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={n.d} />
            </svg>
            {n.label}
          </button>
        ))}
      </nav>

      <div className="m-4 rounded-xl border border-[#131c30] bg-[#0b1120] p-4">
        <div className="flex items-center gap-2 text-xs text-slate-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          {NETWORK_LABEL}
        </div>
        <div className="mt-1 text-[10px] text-slate-600">chain 61999 · Intelligent Consensus · LLM validators</div>
        <div className="mt-3 border-t border-[#131c30] pt-3 text-[10px] text-slate-600">
          {wallet ? (
            <>Operator <span className="font-mono text-slate-400">{short(wallet)}</span></>
          ) : (
            <>Operator <span className="text-amber-500/80">not connected</span></>
          )}
        </div>
      </div>
    </aside>
  );
}

function Terminal({ logs, termRef }: { logs: LogEntry[]; termRef: React.RefObject<HTMLDivElement | null> }) {
  const color: Record<LogLevel, string> = {
    info: 'text-slate-300',
    success: 'text-emerald-400',
    warn: 'text-amber-300',
    error: 'text-rose-400',
    ai: 'text-cyan-300',
  };
  return (
    <div className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#131c30] bg-[#090e1a]">
      <div className="flex items-center gap-2 border-b border-[#131c30] px-4 py-3">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-[11px] font-medium uppercase tracking-widest text-slate-400">
          Terminal — genvm://collateralguard
        </span>
      </div>
      <div ref={termRef} className="flex-1 space-y-1.5 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-relaxed">
        {logs.length === 0 && <div className="text-slate-600">Booting…</div>}
        {logs.map((l) => (
          <div key={l.id} className="flex flex-wrap gap-x-2">
            <span className="text-slate-600">[{l.time}]</span>
            <span className="text-slate-700">▸</span>
            <span className={color[l.level]}>{l.msg}</span>
            {l.txHash && (
              <a
                href={`${EXPLORER_TX}${l.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-400 underline decoration-dotted underline-offset-2 hover:text-cyan-300"
              >
                {short(l.txHash)} ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Professional transaction card — mirrors what the explorer shows, human-readable. */
function TxCard({ tx }: { tx: TxRecord }) {
  return (
    <div className={`rounded-xl border p-4 ${tx.state === 'REVERTED' ? 'border-rose-500/25 bg-rose-500/[0.04]' : 'border-[#131c30] bg-[#0d1526]'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wide ${TX_STATE_PILL[tx.state]}`}>
          {tx.state === 'IN_FLIGHT' && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          )}
          {tx.state === 'IN_FLIGHT' ? 'IN FLIGHT' : tx.state}
        </span>
        <span className={`rounded-full border px-2.5 py-0.5 text-[10px] text-slate-400 ${tx.state === 'REVERTED' ? 'border-rose-500/25' : 'border-[#1e293b]'}`}>
          {tx.chainStatus}
        </span>
        <span className="ml-auto text-[10px] text-slate-600">{tx.time}</span>
      </div>

      <div className="mt-2 font-mono text-xs text-slate-200">
        {tx.method}({tx.argsSummary})
      </div>

      {tx.state === 'EXECUTED' && tx.output && (
        <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-300">
          <span className="font-semibold uppercase tracking-wide text-emerald-400/80">Output · </span>
          {tx.output}
        </div>
      )}

      {tx.state === 'REVERTED' && (
        <div className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-[11px] leading-relaxed text-rose-300">
          <span className="font-semibold uppercase tracking-wide text-rose-400/80">Reverted · </span>
          {tx.revertReason ?? 'contract error — see the explorer for the full trace'}
        </div>
      )}

      {tx.state === 'IN_FLIGHT' && (
        <div className="mt-2 text-[11px] text-amber-300/80">
          Validators are executing this call — LLM consensus can take up to a minute.
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
        {tx.votesTotal > 0 && (
          <span>
            Consensus <span className="font-semibold text-slate-300">{tx.votesAgree}/{tx.votesTotal}</span> validators agreed
          </span>
        )}
        <a
          href={`${EXPLORER_TX}${tx.hash}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-cyan-400 underline decoration-dotted hover:text-cyan-300"
        >
          {short(tx.hash)} ↗ explorer
        </a>
      </div>
    </div>
  );
}

function AddFundsModal({
  onClose, onSubmit, pending, defaultAccount,
}: {
  onClose: () => void;
  onSubmit: (form: { account: string; collateral: string; debt: string; asset: string }) => void;
  pending: boolean;
  defaultAccount: string;
}) {
  const [form, setForm] = useState({ account: defaultAccount, collateral: '25', debt: '55000', asset: 'ETH' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const field = 'w-full rounded-lg border border-[#1e293b] bg-[#070b14] px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-400/60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[#1b2b47] bg-[#0b1120] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-lg font-semibold text-slate-100">Add Account / Funds</div>
        <p className="mb-5 text-xs text-slate-500">
          Broadcasts a real transaction to CollateralGuard on {NETWORK_LABEL} (61999). You will sign in MetaMask.
        </p>

        <label className="mb-1.5 block text-xs font-medium text-slate-400">Account address</label>
        <input className={`${field} mb-4 font-mono`} value={form.account} onChange={(e) => set('account', e.target.value)} placeholder="0x…" />

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Collateral asset</label>
            <select className={field} value={form.asset} onChange={(e) => set('asset', e.target.value)}>
              <option>ETH</option>
              <option>WETH</option>
              <option>BTC</option>
              <option>SOL</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Collateral amount</label>
            <input className={field} type="number" min="1" value={form.collateral} onChange={(e) => set('collateral', e.target.value)} />
          </div>
        </div>

        <label className="mb-1.5 block text-xs font-medium text-slate-400">Debt (USDT)</label>
        <input className={`${field} mb-6`} type="number" min="1" value={form.debt} onChange={(e) => set('debt', e.target.value)} />

        <div className="flex gap-3">
          <button className="flex-1 rounded-lg border border-[#1e293b] px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            className="flex-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            onClick={() => onSubmit(form)}
            disabled={pending}
          >
            {pending ? 'Waiting for signature…' : 'Sign & Broadcast'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PositionsTable({
  positions, txByAccount, checkingAddr, onCheck, priceOf,
}: {
  positions: Position[];
  txByAccount: Record<string, string>;
  checkingAddr: string | null;
  onCheck: (p: Position) => void;
  priceOf: (asset: string) => number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#131c30] bg-[#0b1120]">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-[#131c30] text-[10px] uppercase tracking-widest text-slate-600">
              <th className="px-5 py-3 font-medium">Account</th>
              <th className="px-3 py-3 font-medium">Collateral</th>
              <th className="px-3 py-3 font-medium">Debt</th>
              <th className="px-3 py-3 font-medium">Ratio</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-5 py-3 text-right font-medium">Engine</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.address} className="border-b border-[#0e1526] last:border-0 hover:bg-[#0d1526]/60">
                <td className="px-5 py-3.5">
                  <div className="font-mono text-slate-200">{short(p.address)}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-600">
                    {p.localOnly ? (
                      <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">preview</span>
                    ) : (
                      <span>on-chain</span>
                    )}
                    {txByAccount[p.address] && (
                      <a
                        href={`${EXPLORER_TX}${txByAccount[p.address]}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-500 underline decoration-dotted hover:text-cyan-400"
                      >
                        tx ↗
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3.5">
                  <span className="font-semibold text-slate-200">{p.collateral_amount}</span>{' '}
                  <span className="text-slate-500">{p.collateral_asset}</span>
                  <div className="text-[10px] text-slate-600">
                    {fmtUSD(p.collateral_amount * priceOf(p.collateral_asset))}
                  </div>
                </td>
                <td className="px-3 py-3.5 text-slate-400">{fmtUSD(p.debt_amount)}</td>
                <td className="px-3 py-3.5">
                  <div className={`font-semibold ${p.last_ratio >= THRESHOLD ? 'text-emerald-400' : p.last_ratio > 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                    {p.last_ratio > 0 ? `${p.last_ratio}%` : '—'}
                  </div>
                  <div className="relative mt-1 h-1.5 w-20 rounded bg-[#141d33]">
                    <div
                      className={`h-1.5 rounded ${p.last_ratio >= THRESHOLD ? 'bg-emerald-400' : 'bg-rose-400'}`}
                      style={{ width: `${Math.min(100, (p.last_ratio / 300) * 100)}%` }}
                    />
                    <div className="absolute -top-1 h-3.5 w-px bg-rose-400/60" style={{ left: `${(THRESHOLD / 300) * 100}%` }} />
                  </div>
                </td>
                <td className="px-3 py-3.5">
                  <StatusBadge status={p.status} />
                  <div className="mt-1 max-w-[220px] truncate text-[10px] text-slate-600" title={p.last_message}>
                    {p.last_message}
                  </div>
                </td>
                <td className="px-5 py-3.5 text-right">
                  <button
                    className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                    onClick={() => onCheck(p)}
                    disabled={checkingAddr !== null}
                  >
                    {checkingAddr === p.address ? 'Validators…' : 'Run Check()'}
                  </button>
                  <div className="mt-1 text-[10px] text-slate-600">{p.last_checked}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─────────────────────────────── PAGE ───────────────────────────────── */

export default function Page() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [wallet, setWallet] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [positions, setPositions] = useState<Position[]>(SEED_POSITIONS);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [checkingAddr, setCheckingAddr] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [protocol, setProtocol] = useState<ProtocolState | null>(null);
  const [txByAccount, setTxByAccount] = useState<Record<string, string>>({});
  const [contractAddr, setContractAddr] = useState(DEFAULT_CONTRACT_ADDRESS);
  const [addrInput, setAddrInput] = useState(DEFAULT_CONTRACT_ADDRESS);
  const [livePrices, setLivePrices] = useState<Record<string, number> | null>(null);
  const [priceStamp, setPriceStamp] = useState<string | null>(null);

  const writeClientRef = useRef<GenClient | null>(null);
  const logIdRef = useRef(1);
  const termRef = useRef<HTMLDivElement | null>(null);

  const paused = protocol?.paused === true;

  const pushLog = useCallback((level: LogLevel, msg: string, txHash?: string) => {
    setLogs((prev) => [
      ...prev.slice(-200),
      { id: logIdRef.current++, time: new Date().toLocaleTimeString('en-GB'), level, msg, txHash },
    ]);
  }, []);

  const updateTx = useCallback((hash: string, patch: Partial<TxRecord>) => {
    setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, ...patch } : t)));
  }, []);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    const saved = window.localStorage.getItem(ADDRESS_STORAGE_KEY);
    if (saved && /^0x[0-9a-fA-F]{40}$/.test(saved)) {
      setContractAddr(saved);
      setAddrInput(saved);
    }
    pushLog('info', 'CollateralGuard risk engine online — GenLayer Intelligent Consensus ready');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pushLog('info', `Target contract: ${short(contractAddr)} on ${NETWORK_LABEL} (61999)`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractAddr]);

  /* ── live market prices for the dashboard (display-only) ── */

  const fetchLivePrices = useCallback(async () => {
    try {
      const ids = [...new Set(Object.values(COINGECKO_IDS))].join(',');
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { cache: 'no-store' });
      if (!res.ok) return;
      const j: any = await res.json();
      const next: Record<string, number> = {};
      for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
        const usd = j?.[id]?.usd;
        if (typeof usd === 'number' && usd > 0) next[sym] = usd;
      }
      if (Object.keys(next).length > 0) {
        setLivePrices((prev) => ({ ...(prev ?? {}), ...next }));
        setPriceStamp(new Date().toLocaleTimeString('en-GB'));
      }
    } catch {
      /* keep the last good values, or the static fallbacks */
    }
  }, []);

  useEffect(() => {
    void fetchLivePrices();
    const iv = setInterval(() => void fetchLivePrices(), 60_000);
    return () => clearInterval(iv);
  }, [fetchLivePrices]);

  const priceOf = useCallback(
    (asset: string) => livePrices?.[asset.toUpperCase()] ?? DISPLAY_PRICES[asset.toUpperCase()] ?? 1000,
    [livePrices],
  );

  /* ── GenVM reads/writes through the official SDK ── */

  const callView = useCallback(
    async (method: string, args: unknown[] = []): Promise<unknown> => {
      return await getReadClient().readContract({
        address: contractAddr as `0x${string}`,
        functionName: method,
        args: args as any,
      });
    },
    [contractAddr],
  );

  const refreshProtocolState = useCallback(async () => {
    try {
      const ps = await callView('get_protocol_state', []);
      const st = typeof ps === 'string' ? JSON.parse(ps) : ps;
      if (st && typeof st === 'object') setProtocol(st as ProtocolState);
      return st as ProtocolState | null;
    } catch {
      return null;
    }
  }, [callView]);

  const syncFromChain = useCallback(async () => {
    try {
      const raw = await callView('get_all_accounts', []);
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(list) && list.length > 0) {
        setPositions(list.map((r: any) => ({ ...r, address: r.address, localOnly: false }) as Position));
        pushLog('success', `Synced ${list.length} monitored account(s) from GenVM state`);
      } else if (Array.isArray(list)) {
        pushLog('info', 'Contract is live on-chain with no monitored accounts yet — add one to begin');
      }
      await refreshProtocolState();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/not found/i.test(msg)) {
        pushLog('error', `Contract ${short(contractAddr)} not found on ${NETWORK_LABEL} — check the address (Settings) and keep it exactly checksummed`);
      } else {
        pushLog('error', `Chain read failed: ${msg.slice(0, 160)}`);
      }
    }
  }, [callView, pushLog, refreshProtocolState, contractAddr]);

  /** Broadcast a write and register it in the live transaction panel. */
  const sendWrite = useCallback(
    async (method: string, args: unknown[]): Promise<string> => {
      const client = writeClientRef.current;
      if (!client) throw new Error('wallet not connected');
      const txHash = await client.writeContract({
        address: contractAddr as `0x${string}`,
        functionName: method,
        args: args as any,
        value: BigInt(0),
      });
      const record: TxRecord = {
        hash: txHash,
        method,
        argsSummary: args.map((a) => (typeof a === 'string' && a.startsWith('0x') ? short(a) : String(a))).join(', '),
        time: new Date().toLocaleTimeString('en-GB'),
        state: 'IN_FLIGHT',
        chainStatus: 'PENDING',
        votesAgree: 0,
        votesTotal: 0,
      };
      setTxs((prev) => [record, ...prev].slice(0, 40));
      pushLog('info', `Tx broadcast: ${method}(${record.argsSummary}) — waiting for validator consensus…`, txHash);
      return txHash;
    },
    [contractAddr, pushLog],
  );

  /**
   * Poll the chain until the tx settles, classifying the REAL execution
   * outcome (a reverted call still reaches FINALIZED — "ACCEPTED" alone
   * proves nothing). Updates the transaction panel live while polling.
   */
  const trackTx = useCallback(
    async (hash: string, attempts = 60, delayMs = 3000): Promise<TxRecord> => {
      let latest: TxRecord | undefined;
      for (let i = 0; i < attempts; i++) {
        await sleep(delayMs);
        try {
         const t: any = await getReadClient().getTransaction({ hash: hash as any });
          if (!t) continue;
          const statusNum = Number(t.status);
          const chainStatus = STATUS_NAMES[statusNum] ?? String(t.statusName ?? statusNum);
          const votes: Record<string, string> = t.consensus_data?.votes ?? {};
          const voteVals = Object.values(votes);
          const agree = voteVals.filter((v) => v === 'agree').length;
          const receipts = t.consensus_data?.leader_receipt;
          const leader = Array.isArray(receipts) ? receipts[0] : undefined;
          const execStatus: string | undefined = leader?.result?.status;

          const patch: Partial<TxRecord> = { chainStatus, votesAgree: agree, votesTotal: voteVals.length };

          const reverted =
            execStatus === 'contract_error' ||
            leader?.execution_result === 'ERROR' ||
            chainStatus === 'UNDETERMINED';

          if (reverted) {
            const reason =
              parseRevertReason(leader?.genvm_result?.stderr) ??
              (leader?.result?.payload ? String(leader.result.payload) : undefined) ??
              'execution error';
            patch.state = 'REVERTED';
            patch.revertReason = reason;
            latest = { hash, method: '', argsSummary: '', time: '', state: 'REVERTED', chainStatus, votesAgree: agree, votesTotal: voteVals.length, revertReason: reason };
            updateTx(hash, patch);
            return latest;
          }

          if (DECIDED.has(statusNum) && leader && execStatus) {
            const output = leader?.result?.raw ? decodeReturnPayload(String(leader.result.raw)) : undefined;
            patch.state = 'EXECUTED';
            patch.output = output;
            latest = { hash, method: '', argsSummary: '', time: '', state: 'EXECUTED', chainStatus, votesAgree: agree, votesTotal: voteVals.length, output };
            updateTx(hash, patch);
            return latest;
          }

          updateTx(hash, patch);
        } catch {
          /* not indexed yet — keep polling */
        }
      }
      return latest ?? { hash, method: '', argsSummary: '', time: '', state: 'IN_FLIGHT', chainStatus: 'PENDING', votesAgree: 0, votesTotal: 0 };
    },
    [updateTx],
  );

  const pollPosition = useCallback(
    async (addr: string, attempts = 12, delayMs = 4000): Promise<Position | null> => {
      for (let i = 0; i < attempts; i++) {
        await sleep(delayMs);
        try {
          const raw = await callView('get_position_status', [addr]);
          if (typeof raw === 'string' && raw !== 'NOT_FOUND') {
            const rec = JSON.parse(raw);
            return { ...rec, address: addr } as Position;
          }
        } catch {
          /* consensus still settling */
        }
      }
      return null;
    },
    [callView],
  );

  /* ── wallet ── */

  const connectWallet = useCallback(async (): Promise<string | null> => {
    const eth = window.ethereum;
    if (!eth) {
      pushLog('error', 'MetaMask not detected — install it to interact with GenLayer');
      return null;
    }
    try {
      setConnecting(true);
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      const addr = accounts?.[0] ?? null;
      if (addr) {
        const client = createClient({
          chain: studionet,
          account: addr as `0x${string}`,
          provider: eth,
        });
        await client.connect('studionet');
        writeClientRef.current = client;
        setWallet(addr);
        pushLog('success', `Wallet connected: ${short(addr)} — ${NETWORK_LABEL} (61999)`);
        await syncFromChain();
      }
      return addr;
    } catch (e: any) {
      pushLog('error', `Wallet connection failed: ${e?.shortMessage ?? e?.message ?? e}`);
      return null;
    } finally {
      setConnecting(false);
    }
  }, [pushLog, syncFromChain]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    eth
      .request({ method: 'eth_accounts' })
      .then((accs: string[]) => {
        if (accs?.length) void connectWallet();
      })
      .catch(() => {});
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) {
        setWallet(null);
        writeClientRef.current = null;
        pushLog('warn', 'Wallet disconnected');
      } else {
        setWallet(accs[0]);
      }
    };
    eth.on?.('accountsChanged', onAccounts);
    return () => eth.removeListener?.('accountsChanged', onAccounts);
  }, [connectWallet, pushLog]);

  /* ── actions ── */

  const upsert = useCallback((p: Position) => {
    setPositions((prev) => {
      const i = prev.findIndex((x) => x.address.toLowerCase() === p.address.toLowerCase());
      if (i === -1) return [...prev, p];
      const next = [...prev];
      next[i] = { ...prev[i], ...p };
      return next;
    });
  }, []);

  const runCheck = useCallback(
    async (pos: Position) => {
      if (!wallet) {
        const w = await connectWallet();
        if (!w || !writeClientRef.current) return;
      }
      setCheckingAddr(pos.address);
      try {
        let target = pos;
        if (pos.localOnly) {
          pushLog('info', `${short(pos.address)} is a preview row — adding it on-chain first…`);
          const addHash = await sendWrite(
            'add_monitored_account',
            [pos.address, pos.collateral_amount, pos.debt_amount, pos.collateral_asset, pos.debt_asset],
          );
          const addOutcome = await trackTx(addHash);
          if (addOutcome.state === 'REVERTED') {
            pushLog('error', `Could not add ${short(pos.address)} on-chain — ${addOutcome.revertReason}`, addHash);
            return;
          }
          target = { ...pos, localOnly: false };
          upsert(target);
        }

        const before = await callView('get_position_status', [target.address]).catch(() => undefined);
        pushLog('ai', `check_and_protect(${short(target.address)}) → validators fetching ${target.collateral_asset} price via Binance, then LLM consensus…`);
        const hash = await sendWrite('check_and_protect', [target.address]);
        const outcome = await trackTx(hash);

        if (outcome.state === 'REVERTED') {
          const hint = /PROTOCOL_PAUSED/i.test(outcome.revertReason ?? '')
            ? ' — open Risk Engine and press Resume Protocol, then run the check again'
            : '';
          pushLog('error', `check_and_protect REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}${hint}`, hash);
          await refreshProtocolState();
          return;
        }

        pushLog('ai', 'Equivalence principle satisfied — every validator agreed on the risk verdict…');
        const fresh = await pollPosition(target.address);
        const beforeRec = typeof before === 'string' ? JSON.parse(before) : undefined;
        const unchanged = fresh && beforeRec && fresh.last_checked === beforeRec.last_checked && fresh.last_message === beforeRec.last_message;

        if (fresh && !unchanged) {
          upsert(fresh);
          setTxByAccount((prev) => ({ ...prev, [target.address]: hash }));
          const verdict = outcome.output ?? fresh.last_message;
          const level: LogLevel = fresh.status === 'CRITICAL' ? 'error' : fresh.status === 'WARNING' ? 'warn' : 'success';
          pushLog(level, verdict, hash);
          await refreshProtocolState();
          if (fresh.status === 'CRITICAL') {
            pushLog('error', 'CIRCUIT BREAKER ENGAGED — every further check() will revert until the owner resumes the protocol');
          }
        } else {
          pushLog('warn', 'Verdict not visible in state yet — open Transactions for the on-chain output, or press Refresh shortly', hash);
        }
      } catch (e: any) {
        pushLog('error', `check_and_protect failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setCheckingAddr(null);
      }
    },
    [wallet, connectWallet, pushLog, sendWrite, trackTx, pollPosition, upsert, callView, refreshProtocolState],
  );

  const submitAddFunds = useCallback(
    async (form: { account: string; collateral: string; debt: string; asset: string }) => {
      const account = form.account.trim();
      const collateral = Math.round(Number(form.collateral));
      const debt = Math.round(Number(form.debt));
      if (!/^0x[0-9a-fA-F]{6,}$/.test(account)) {
        pushLog('error', 'INVALID_ADDRESS — account must be a hex address (0x…)');
        return;
      }
      if (!Number.isFinite(collateral) || collateral <= 0 || !Number.isFinite(debt) || debt <= 0) {
        pushLog('error', 'INVALID_AMOUNT — collateral and debt must be positive numbers');
        return;
      }
      setAdding(true);
      try {
        if (!wallet) {
          const w = await connectWallet();
          if (!w || !writeClientRef.current) return;
        }
        const hash = await sendWrite('add_monitored_account', [account, collateral, debt, form.asset, 'USDT']);
        const outcome = await trackTx(hash);
        if (outcome.state === 'REVERTED') {
          pushLog('error', `add_monitored_account REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}`, hash);
          return;
        }
        upsert({
          address: account,
          collateral_amount: collateral,
          debt_amount: debt,
          collateral_asset: form.asset,
          debt_asset: 'USDT',
          status: 'SAFE',
          last_ratio: 0,
          ai_sentiment: 'N/A',
          last_message: outcome.output ?? 'Initialized. Awaiting first check().',
          last_checked: 'NEVER',
        });
        setTxByAccount((prev) => ({ ...prev, [account]: hash }));
        setModalOpen(false);
        pushLog('success', outcome.output ?? `FUNDS_ADDED: ${short(account)} is now monitored`, hash);
        void pollPosition(account, 6, 4000).then((fresh) => {
          if (fresh) upsert(fresh);
        });
      } catch (e: any) {
        pushLog('error', `add_monitored_account failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setAdding(false);
      }
    },
    [wallet, connectWallet, pushLog, sendWrite, trackTx, upsert, pollPosition],
  );

  const resumeProtocol = useCallback(async () => {
    setResuming(true);
    pushLog('info', 'resume_protocol() — only the deployer can disengage the circuit breaker…');
    try {
      const hash = await sendWrite('resume_protocol', []);
      const outcome = await trackTx(hash);
      if (outcome.state === 'REVERTED') {
        pushLog('error', `resume_protocol REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}`, hash);
        return;
      }
      for (let i = 0; i < 8; i++) {
        const st = await refreshProtocolState();
        if (st && st.paused === false) {
          pushLog('success', outcome.output ?? 'PROTOCOL_RESUMED: circuit breaker disengaged — checks are live again', hash);
          return;
        }
        await sleep(4000);
      }
      pushLog('warn', 'Resume still settling in consensus — check again shortly', hash);
    } catch (e: any) {
      pushLog('error', `resume_protocol failed: ${e?.shortMessage ?? e?.message ?? e}`);
    } finally {
      setResuming(false);
    }
  }, [pushLog, sendWrite, trackTx, refreshProtocolState]);

  const saveAddress = useCallback(() => {
    const v = addrInput.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      pushLog('error', 'That is not a valid 20-byte address (0x + 40 hex chars)');
      return;
    }
    window.localStorage.setItem(ADDRESS_STORAGE_KEY, v);
    setContractAddr(v);
    pushLog('info', `Contract address updated to ${short(v)} — syncing…`);
    void syncFromChain();
  }, [addrInput, pushLog, syncFromChain]);

  /* ── derived dashboard data ── */

  const stats = useMemo(() => {
    const coll = positions.reduce((s, p) => s + p.collateral_amount * priceOf(p.collateral_asset), 0);
    const debt = positions.reduce((s, p) => s + p.debt_amount, 0);
    const health = debt > 0 ? Math.round((coll * 100) / debt) : 0;
    return { coll, debt, health };
  }, [positions, priceOf]);

  const allocation = useMemo(() => {
    const byAsset: Record<string, number> = {};
    for (const p of positions) {
      byAsset[p.collateral_asset] = (byAsset[p.collateral_asset] ?? 0) + p.collateral_amount * priceOf(p.collateral_asset);
    }
    return Object.entries(byAsset).map(([asset, value]) => ({
      label: asset,
      value,
      color: ASSET_COLORS[asset] ?? '#64748b',
    }));
  }, [positions, priceOf]);

  const healthColor = stats.health >= THRESHOLD ? 'text-emerald-400' : 'text-rose-400';
  const unconfigured = contractAddr === '0x0000000000000000000000000000000000000000';
  const inFlight = txs.filter((t) => t.state === 'IN_FLIGHT').length;

  const tableEl = (
    <PositionsTable positions={positions} txByAccount={txByAccount} checkingAddr={checkingAddr} onCheck={(p) => void runCheck(p)} priceOf={priceOf} />
  );

  return (
    <div className="flex min-h-screen bg-[#070b14] text-slate-200">
      <Sidebar wallet={wallet} tab={tab} onTab={setTab} />

      <main className="min-w-0 flex-1">
        {/* header */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#131c30] px-6 py-5">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">DeFi Risk Engine</h1>
            <p className="text-xs text-slate-500">
              CollateralGuard · Intelligent Contracts on {NETWORK_LABEL} (61999)
            </p>
          </div>
          <div className="flex items-center gap-3">
            {inFlight > 0 && (
              <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                {inFlight} tx{inFlight > 1 ? 's' : ''} in consensus
              </span>
            )}
            <span className="hidden rounded-full border border-[#1b2b47] bg-[#0d1526] px-3 py-1.5 text-[11px] text-slate-400 sm:inline">
              LIQ threshold <span className="font-semibold text-slate-200">{asNum(protocol?.threshold) || THRESHOLD}%</span>
            </span>
            {wallet ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-medium text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="font-mono">{short(wallet)}</span>
              </span>
            ) : (
              <button
                className="rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                onClick={() => void connectWallet()}
                disabled={connecting}
              >
                {connecting ? 'Connecting…' : 'Connect Wallet'}
              </button>
            )}
          </div>
        </header>

        <div className="space-y-6 px-6 py-6">
          {unconfigured && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">
              Demo mode — no contract address configured. Deploy CollateralGuard.py and set the address in the Settings tab.
            </div>
          )}

          {paused && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <div className="flex items-center gap-3 text-sm text-rose-300">
                <span className="h-2 w-2 animate-ping rounded-full bg-rose-400" />
                <span className="font-semibold">Circuit breaker active</span>
                <span className="text-rose-300/70">— a collateral ratio breached the threshold; all checks revert until resumed.</span>
              </div>
              <button
                className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                onClick={() => void resumeProtocol()}
                disabled={resuming}
              >
                {resuming ? 'Resuming…' : 'Resume Protocol'}
              </button>
            </div>
          )}

          {tab === 'dashboard' && (
            <>
              {/* live market ticker (display prices — verdicts use the validators' own feed) */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[#131c30] bg-[#0b1120] px-4 py-2.5 text-xs">
                {['ETH', 'BTC', 'SOL'].map((sym) => (
                  <span key={sym} className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: ASSET_COLORS[sym] ?? '#64748b' }} />
                    <span className="text-slate-500">{sym}</span>
                    <span className="font-mono text-slate-200">
                      ${(livePrices?.[sym] ?? DISPLAY_PRICES[sym]).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                  </span>
                ))}
                <span className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-500">
                  <span className={`h-1.5 w-1.5 rounded-full ${livePrices ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                  {livePrices ? `live · CoinGecko · updated ${priceStamp}` : 'static fallback prices — CoinGecko unreachable'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                {[
                  { label: 'Total Collateral', value: fmtUSD(stats.coll), sub: 'across monitored accounts', accent: 'text-cyan-300' },
                  { label: 'Total Debt', value: fmtUSD(stats.debt), sub: 'USDT denominated', accent: 'text-rose-300' },
                  { label: 'Portfolio Health', value: `${stats.health}%`, sub: `threshold ${THRESHOLD}%`, accent: healthColor },
                  { label: 'Consensus Checks', value: String(asNum(protocol?.total_checks)), sub: paused ? 'protocol paused' : 'protocol operational', accent: 'text-slate-100' },
                ].map((c) => (
                  <div key={c.label} className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-4">
                    <div className="text-[11px] uppercase tracking-widest text-slate-500">{c.label}</div>
                    <div className={`mt-1.5 text-2xl font-semibold ${c.accent}`}>{c.value}</div>
                    <div className="mt-1 text-[11px] text-slate-600">{c.sub}</div>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5">
                  <div className="mb-3 text-sm font-medium text-slate-300">Asset Allocation</div>
                  <div className="flex items-center gap-4">
                    <Donut
                      segments={allocation.length ? allocation : [{ label: '—', value: 1, color: '#141d33' }]}
                      centerLabel={fmtUSD(stats.coll)}
                      centerSub="collateral"
                    />
                    <div className="space-y-2">
                      {allocation.map((a) => (
                        <div key={a.label} className="flex items-center gap-2 text-xs">
                          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
                          <span className="text-slate-300">{a.label}</span>
                          <span className="text-slate-600">{fmtUSD(a.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5">
                  <div className="mb-3 text-sm font-medium text-slate-300">Collateral vs Debt</div>
                  <div className="flex items-center gap-4">
                    <Donut
                      segments={[
                        { label: 'Collateral', value: stats.coll, color: '#22d3ee' },
                        { label: 'Debt', value: stats.debt, color: '#fb7185' },
                      ]}
                      centerLabel={`${stats.health}%`}
                      centerSub="health"
                    />
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm bg-cyan-400" />
                        <span className="text-slate-300">Collateral</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm bg-rose-400" />
                        <span className="text-slate-300">Debt</span>
                      </div>
                      <div className="pt-2 text-[11px] text-slate-600">
                        Health = collateral ÷ debt. Below {THRESHOLD}% the engine trips the breaker.
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5">
                  <div className="mb-1 text-sm font-medium text-slate-300">Portfolio Health — 27h</div>
                  <div className="text-[11px] text-slate-600">simulated timeline · live verdicts mark the current point</div>
                  <div className="mt-2 h-[200px]">
                    <HealthTimeline positions={positions} threshold={THRESHOLD} prices={livePrices ?? DISPLAY_PRICES} />
                  </div>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                <div className="min-w-0 xl:col-span-2">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-medium text-slate-300">Monitored Positions</div>
                    <div className="flex gap-2">
                      <button
                        className="rounded-lg border border-[#1e293b] px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                        onClick={() => void syncFromChain()}
                      >
                        Refresh
                      </button>
                      <button
                        className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                        onClick={() => setModalOpen(true)}
                      >
                        + Add Account / Funds
                      </button>
                    </div>
                  </div>
                  {tableEl}
                </div>
                <Terminal logs={logs} termRef={termRef} />
              </div>
            </>
          )}

          {tab === 'accounts' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-300">Monitored Accounts</div>
                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-[#1e293b] px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                    onClick={() => void syncFromChain()}
                  >
                    Refresh
                  </button>
                  <button
                    className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                    onClick={() => setModalOpen(true)}
                  >
                    + Add Account / Funds
                  </button>
                </div>
              </div>
              {tableEl}
            </div>
          )}

          {tab === 'risk' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5">
                <div className="mb-4 text-sm font-medium text-slate-300">Protocol State (on-chain)</div>
                <dl className="space-y-3 text-xs">
                  {[
                    ['Circuit breaker', paused ? 'ENGAGED — protocol paused' : 'disengaged — operational'],
                    ['Safety threshold', `${asNum(protocol?.threshold) || THRESHOLD}%`],
                    ['Consensus checks run', String(asNum(protocol?.total_checks))],
                    ['Owner (can resume)', protocol?.owner ? short(protocol.owner) : '—'],
                    ['Contract', short(contractAddr)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between border-b border-[#0e1526] pb-2 last:border-0">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className={`font-mono ${String(v).startsWith('ENGAGED') ? 'text-rose-400' : 'text-slate-200'}`}>{v}</dd>
                    </div>
                  ))}
                </dl>
                <button
                  className="mt-4 w-full rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                  onClick={() => void resumeProtocol()}
                  disabled={resuming || !paused}
                >
                  {resuming ? 'Resuming…' : paused ? 'Resume Protocol (owner only)' : 'Protocol operational — nothing to resume'}
                </button>
              </div>
              <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5 text-xs leading-relaxed text-slate-400">
                <div className="mb-3 text-sm font-medium text-slate-300">How a Check() works</div>
                <ol className="list-decimal space-y-2 pl-4">
                  <li>Your Run Check() broadcasts <span className="font-mono text-cyan-300">check_and_protect</span> through MetaMask to the consensus contract.</li>
                  <li>Five independent LLM validators each fetch the live asset price from Binance and recompute the collateral ratio.</li>
                  <li>The equivalence principle requires them to agree on the verdict category (SAFE / WARNING / CRITICAL) — numeric drift from live prices is tolerated.</li>
                  <li>SAFE holds, WARNING flags catastrophic AI sentiment, and a ratio below {THRESHOLD}% trips the circuit breaker and pauses the protocol.</li>
                  <li>If the price feed is unreachable, validators use a fallback price and the verdict is flagged <span className="font-mono">[price feed unavailable — used fallback price]</span>.</li>
                </ol>
              </div>
            </div>
          )}

          {tab === 'transactions' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-slate-300">Transaction Activity</div>
                  <div className="text-[11px] text-slate-600">Live on-chain outcomes — status, execution result, validator consensus and decoded output</div>
                </div>
                <button
                  className="rounded-lg border border-[#1e293b] px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                  onClick={() => txs.forEach((t) => {
                    if (t.state === 'IN_FLIGHT') void trackTx(t.hash, 1, 1);
                  })}
                >
                  Re-poll pending
                </button>
              </div>
              {txs.length === 0 ? (
                <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] px-5 py-10 text-center text-xs text-slate-600">
                  No transactions yet — run a Check() or add an account. Every broadcast appears here with its live on-chain outcome.
                </div>
              ) : (
                <div className="space-y-3">
                  {txs.map((t) => (
                    <TxCard key={t.hash} tx={t} />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="max-w-xl space-y-4">
              <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5">
                <div className="mb-1 text-sm font-medium text-slate-300">Contract Address</div>
                <p className="mb-3 text-[11px] text-slate-500">
                  Deployed CollateralGuard on {NETWORK_LABEL}. Keep the address exactly as the explorer shows it (checksummed) —
                  the node&apos;s lookup is case-sensitive. Saved in this browser.
                </p>
                <div className="flex gap-2">
                  <input
                    className="w-full rounded-lg border border-[#1e293b] bg-[#070b14] px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-cyan-400/60"
                    value={addrInput}
                    onChange={(e) => setAddrInput(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    className="shrink-0 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
                    onClick={() => saveAddress()}
                  >
                    Save & Sync
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5 text-xs text-slate-400">
                <div className="mb-3 text-sm font-medium text-slate-300">Connection</div>
                <div className="space-y-2">
                  <div className="flex justify-between"><span>Network</span><span className="font-mono text-slate-200">{NETWORK_LABEL} · 61999 (0xf22f)</span></div>
                  <div className="flex justify-between"><span>RPC</span><span className="font-mono text-slate-200">studio.genlayer.com/api</span></div>
                  <div className="flex justify-between"><span>Explorer</span><span className="font-mono text-slate-200">explorer-studio.genlayer.com</span></div>
                  <div className="flex justify-between"><span>Wallet</span><span className="font-mono text-slate-200">{wallet ? short(wallet) : 'not connected'}</span></div>
                  <div className="flex justify-between"><span>SDK</span><span className="font-mono text-slate-200">genlayer-js@1.1.8</span></div>
                </div>
                <button
                  className="mt-4 w-full rounded-lg border border-[#1e293b] px-3 py-2 text-xs text-slate-300 hover:bg-[#0d1526] disabled:opacity-50"
                  onClick={() => {
                    void refreshProtocolState().then((st) => {
                      if (st) pushLog('success', `Diagnostics OK — paused=${st.paused}, threshold=${st.threshold}, checks=${st.total_checks}`);
                      else pushLog('error', 'Diagnostics failed — contract unreachable (check the address above)');
                    });
                  }}
                >
                  Run Diagnostics
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {modalOpen && (
        <AddFundsModal
          defaultAccount={wallet ?? ''}
          pending={adding}
          onClose={() => setModalOpen(false)}
          onSubmit={(f) => void submitAddFunds(f)}
        />
      )}
    </div>
  );
}
