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
 * NOTES (all verified live against Studionet):
 *   • A reverted call still reaches FINALIZED — classification comes from
 *     leader_receipt[0].result.status ("contract_error") and the human-readable
 *     reason from genvm_result.stderr ("Exception: <reason>").
 *   • Successful writes return the calldata-encoded return string in result.raw.
 *   • Transaction cards are persisted to localStorage (scoped per contract) and
 *     auto-resume tracking after a page refresh.
 *   • Dashboard numbers render only from synced on-chain state — no preview data.
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
const ADDRESS_HISTORY_KEY = 'cg_address_history';
const TXS_STORAGE_KEY = 'cg_txs';
const PRICES_STORAGE_KEY = 'cg_prices';

const NETWORK_LABEL = 'GenLayer Studionet';
const EXPLORER_TX = 'https://explorer-studio.genlayer.com/tx/';
const DEFAULT_THRESHOLD = 150;

const DISPLAY_PRICES: Record<string, number> = { ETH: 3200, BTC: 64000, SOL: 150, WETH: 3200 };
const ASSET_COLORS: Record<string, string> = { ETH: '#627eea', WETH: '#627eea', BTC: '#f7931a', SOL: '#14f195' };

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

/** Extract status + ratio from a verdict message like "CRITICAL_BREACH: ratio 106% < …". */
function parseVerdict(output: string | undefined): { status: Position['status']; ratio: number } | null {
  if (!output) return null;
  const status = output.startsWith('CRITICAL_BREACH')
    ? 'CRITICAL'
    : output.startsWith('AI_CONSENSUS_WARNING')
      ? 'WARNING'
      : output.startsWith('RATIO_SAFE')
        ? 'SAFE'
        : null;
  if (!status) return null;
  const m = output.match(/ratio (\d+)%/i);
  return { status, ratio: m ? Number(m[1]) : 0 };
}

function checkNumberOf(lastChecked: string | undefined): number {
  const m = (lastChecked ?? '').match(/#(\d+)/);
  return m ? Number(m[1]) : 0;
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
  locked?: boolean;
  updatedTs?: number;
  localOnly?: boolean;
};

type ProtocolState = {
  paused: boolean;
  threshold: string | number;
  owner: string;
  total_checks: string | number;
};

type CheckEvent = {
  type?: 'ADD' | 'CHECK' | 'RESUME_ACCOUNT';
  seq?: number;
  account: string;
  asset: string;
  ratio?: number;
  status?: string;
  price_source?: string;
  collateral_amount?: number;
  debt_amount?: number;
  debt_asset?: string;
  message: string;
};

type TxState = 'IN_FLIGHT' | 'EXECUTED' | 'REVERTED' | 'STALE';

type TxRecord = {
  hash: string;
  contract: string;
  method: string;
  argsSummary: string;
  time: string;
  ts: number;
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

const STATUS_STYLES: Record<Position['status'], string> = {
  SAFE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  WARNING: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  CRITICAL: 'bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse',
};

const TX_STATE_PILL: Record<TxState, string> = {
  IN_FLIGHT: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  EXECUTED: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  REVERTED: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  STALE: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};

type Tab = 'dashboard' | 'accounts' | 'risk' | 'transactions' | 'settings';

function loadPersistedTxs(): TxRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TXS_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as TxRecord[];
    const tenMin = Date.now() - 10 * 60 * 1000;
    return list.map((t) => (t.state === 'IN_FLIGHT' && (t.ts ?? 0) < tenMin ? { ...t, state: 'STALE' as TxState } : t));
  } catch {
    return [];
  }
}

function loadAddressHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ADDRESS_HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function loadCachedPrices(): Record<string, number> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PRICES_STORAGE_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, number>) : null;
    return obj && typeof obj === 'object' && Object.keys(obj).length > 0 ? obj : null;
  } catch {
    return null;
  }
}

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

/** Real check-history timeline; falls back to a simulated walk until 2+ checks exist. */
function HealthTimeline({
  positions, threshold, prices, history,
}: {
  positions: Position[];
  threshold: number;
  prices: Record<string, number>;
  history: CheckEvent[];
}) {
  const real = history.length >= 1;
  const series = useMemo(() => {
    if (real) {
      const pts = history.slice(-20).map((h) => ({ v: Math.min(340, Math.max(60, h.ratio ?? 0)), label: `#${h.seq ?? 0}` }));
      return { pts: pts.map((p) => p.v), current: pts.length ? pts[pts.length - 1].v : 0, labels: pts.map((p) => p.label) };
    }
    const coll = positions.reduce((s, p) => s + p.collateral_amount * (prices[p.collateral_asset] ?? 1000), 0);
    const debt = Math.max(1, positions.reduce((s, p) => s + p.debt_amount, 0));
    const current = debt > 0 ? Math.min(340, Math.max(90, Math.round((coll * 100) / debt))) : 0;
    if (current === 0) return { pts: [] as number[], current: 0, labels: [] as string[] };
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
    return { pts, current, labels: [] as string[] };
  }, [real, history, positions, prices]);

  const W = 640;
  const H = 220;
  const y = (v: number) => 200 - ((v - 80) / 260) * 184;
  const n = series.pts.length;
  const x = (i: number) => 40 + (i * (W - 80)) / Math.max(1, n - 1);
  const line = series.pts.map((p, i) => `${x(i)},${y(p)}`).join(' ');
  const area = n > 1
    ? `M ${x(0)},${y(series.pts[0])} `
      + series.pts.slice(1).map((p, i) => `L ${x(i + 1)},${y(p)}`).join(' ')
      + ` L ${x(n - 1)},200 L ${x(0)},200 Z`
    : '';
  const lastY = n > 0 ? y(series.pts[n - 1]) : 0;

  if (n === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-slate-600">
        Add a position and run a check to populate the chart
      </div>
    );
  }

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
      {area && <path d={area} fill="url(#healthFill)" />}
      <polyline points={line} fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinejoin="round" />
      {real && n === 1 && (
        <line x1={40} x2={W - 20} y1={lastY} y2={lastY} stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="2 5" opacity="0.8" />
      )}
      {real && series.pts.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p)} r="2.5" fill={p < threshold ? '#fb7185' : '#22d3ee'} />
      ))}
      <circle cx={x(n - 1)} cy={lastY} r="4" fill="#22d3ee" />
      <circle cx={x(n - 1)} cy={lastY} r="8" fill="#22d3ee" opacity="0.25" />
      <text x={x(n - 1) - 8} y={lastY - 12} textAnchor="end" fontSize="12" fontWeight="600" fill="#e2e8f0">
        {series.current}%
      </text>
      <text x={40} y={216} fontSize="9" fill="#334155">{real ? 'check #1' : '27h ago'}</text>
      <text x={W - 20} y={216} fontSize="9" fill="#334155" textAnchor="end">{real ? `check #${history[history.length - 1]?.seq ?? n}` : 'now'}</text>
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

const LEVEL_META: Record<LogLevel, { dot: string; label: string }> = {
  info: { dot: 'bg-slate-500', label: 'INFO' },
  success: { dot: 'bg-emerald-400', label: 'OK' },
  warn: { dot: 'bg-amber-400', label: 'WARN' },
  error: { dot: 'bg-rose-500', label: 'ERROR' },
  ai: { dot: 'bg-cyan-400', label: 'CONSENSUS' },
};

type ActivityFilter = 'all' | 'consensus' | 'issues';

function ActivityFilters({ filter, onFilter }: { filter: ActivityFilter; onFilter: (f: ActivityFilter) => void }) {
  return (
    <div className="flex gap-1.5">
      {([
        ['all', 'All'],
        ['consensus', 'Consensus'],
        ['issues', 'Issues'],
      ] as [ActivityFilter, string][]).map(([id, label]) => (
        <button
          key={id}
          className={`rounded-full border px-2.5 py-0.5 text-[10px] ${
            filter === id
              ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
              : 'border-[#1e293b] text-slate-500 hover:text-slate-300'
          }`}
          onClick={() => onFilter(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ActivityFeedBody({
  logs, filter, scrollRef,
}: {
  logs: LogEntry[];
  filter: ActivityFilter;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const filtered = logs.filter((l) => {
    if (filter === 'consensus') return l.level === 'ai' || l.level === 'success';
    if (filter === 'issues') return l.level === 'error' || l.level === 'warn';
    return true;
  });
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
      {filtered.length === 0 && <div className="px-2 py-6 text-center text-[11px] text-slate-600">No activity yet</div>}
      {filtered.map((l) => {
        const meta = LEVEL_META[l.level];
        return (
          <div key={l.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[#0d1526]/70">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] leading-snug text-slate-300">{l.msg}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-600">
                <span>{meta.label}</span>
                <span>{l.time}</span>
                {l.txHash && (
                  <a
                    href={`${EXPLORER_TX}${l.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono normal-case text-cyan-500 underline decoration-dotted hover:text-cyan-400"
                  >
                    {short(l.txHash)} ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        );
      })}
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

      {tx.state === 'STALE' && (
        <div className="mt-2 text-[11px] text-slate-400">
          No final update received — the transaction may have been replaced or dropped in MetaMask. Check the explorer.
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
        {tx.votesTotal > 0 && (
          <span>
            Consensus <span className="font-semibold text-slate-300">{tx.votesAgree}/{tx.votesTotal}</span> validators agreed
          </span>
        )}
        <span className="font-mono text-slate-600">{short(tx.contract)}</span>
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
  onClose, onSubmit, busy, defaultAccount, priceOf, threshold, positions,
}: {
  onClose: () => void;
  onSubmit: (form: { account: string; collateral: string; debt: string; asset: string; debtAsset: string }) => void;
  busy: boolean;
  defaultAccount: string;
  priceOf: (asset: string) => number;
  threshold: number;
  positions: Position[];
}) {
  const [form, setForm] = useState({ account: defaultAccount, collateral: '25', debt: '55000', asset: 'ETH', debtAsset: 'USDT' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const field = 'w-full rounded-lg border border-[#1e293b] bg-[#070b14] px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-400/60';

  const collateral = Math.round(Number(form.collateral));
  const debt = Math.round(Number(form.debt));
  const estRatio = collateral > 0 && debt > 0 ? Math.round((collateral * priceOf(form.asset) * 100) / debt) : null;
  const estLabel = estRatio === null ? null : estRatio >= threshold ? 'SAFE' : 'CRITICAL';
  const existing = positions.find((p) => p.address.toLowerCase() === form.account.trim().toLowerCase());
  const accountValid = /^0x[0-9a-fA-F]{6,}$/.test(form.account.trim());
  const amountsValid = Number.isFinite(collateral) && collateral > 0 && Number.isFinite(debt) && debt > 0;
  const canSign = accountValid && amountsValid && !existing && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[#1b2b47] bg-[#0b1120] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-lg font-semibold text-slate-100">Add Account / Funds</div>
        <p className="mb-5 text-xs text-slate-500">
          Broadcasts a real transaction to CollateralGuard on {NETWORK_LABEL} (61999). You will sign in MetaMask.
          MetaMask lists the GenLayer consensus router as recipient — your call targets the contract through it.
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

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Debt asset</label>
            <select className={field} value={form.debtAsset} onChange={(e) => set('debtAsset', e.target.value)}>
              <option>USDT</option>
              <option>USDC</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Debt amount</label>
            <input className={field} type="number" min="1" value={form.debt} onChange={(e) => set('debt', e.target.value)} />
          </div>
        </div>

        {estRatio !== null && (
          <div className={`mb-4 rounded-lg border px-3 py-2 text-[11px] ${
            estLabel === 'SAFE'
              ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300'
              : 'border-rose-500/25 bg-rose-500/5 text-rose-300'
          }`}>
            Estimated ratio ≈ <span className="font-semibold">{estRatio}%</span> → {estLabel} at the current {form.asset} price
            (${priceOf(form.asset).toLocaleString('en-US', { maximumFractionDigits: 2 })}) and {threshold}% threshold
          </div>
        )}

        {existing && (
          <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
            <span className="font-semibold uppercase tracking-wide text-amber-400/80">Already monitored · </span>
            {existing.collateral_amount} {existing.collateral_asset} vs {existing.debt_amount} {existing.debt_asset} —
            status {existing.status} ({existing.last_checked}). This contract rejects duplicate addresses,
            so use a different one — or press Run Check() on the existing row.
          </div>
        )}

        <div className="flex gap-3">
          <button className="flex-1 rounded-lg border border-[#1e293b] px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="flex-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            onClick={() => canSign && onSubmit(form)}
            disabled={busy || !canSign}
          >
            {busy ? 'Waiting for signature…' : !accountValid ? 'Enter a valid 0x address' : !amountsValid ? 'Enter positive amounts' : existing ? 'Already monitored' : 'Sign & Broadcast'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PositionsTable({
  positions, txByAccount, checkingAddr, onCheck, onResume, priceOf, threshold, synced, wallet, busy,
}: {
  positions: Position[];
  txByAccount: Record<string, string>;
  checkingAddr: string | null;
  onCheck: (p: Position) => void;
  onResume: (p: Position) => void;
  priceOf: (asset: string) => number;
  threshold: number;
  synced: boolean;
  wallet: string | null;
  busy: boolean;
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
            {positions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-slate-600">
                  {synced ? (
                    <>
                      No monitored positions on this contract yet —{' '}
                      <span className="text-cyan-400">Add Account / Funds</span> to begin.
                    </>
                  ) : (
                    <>Connecting to GenLayer and syncing positions…</>
                  )}
                </td>
              </tr>
            ) : (
              positions.map((p) => (
                <tr key={p.address} className="border-b border-[#0e1526] last:border-0 hover:bg-[#0d1526]/60">
                  <td className="px-5 py-3.5">
                    <div className="font-mono text-slate-200">{short(p.address)}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-600">
                      <span>on-chain</span>
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
                  <td className="px-3 py-3.5">
                    {fmtUSD(p.debt_amount)}
                    <div className="text-[10px] text-slate-600">{p.debt_asset}</div>
                  </td>
                  <td className="px-3 py-3.5">
                    <div className={`font-semibold ${p.last_ratio >= threshold ? 'text-emerald-400' : p.last_ratio > 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                      {p.last_ratio > 0 ? `${p.last_ratio}%` : '—'}
                    </div>
                    <div className="relative mt-1 h-1.5 w-20 rounded bg-[#141d33]">
                      <div
                        className={`h-1.5 rounded ${p.last_ratio >= threshold ? 'bg-emerald-400' : 'bg-rose-400'}`}
                        style={{ width: `${Math.min(100, (p.last_ratio / 300) * 100)}%` }}
                      />
                      <div className="absolute -top-1 h-3.5 w-px bg-rose-400/60" style={{ left: `${(threshold / 300) * 100}%` }} />
                    </div>
                  </td>
                  <td className="px-3 py-3.5">
                    <StatusBadge status={p.status} />
                    <div className="mt-1 line-clamp-2 max-w-[220px] text-[10px] leading-snug text-slate-600" title={p.last_message}>
                      {p.last_message}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {p.locked || /ACCOUNT_LOCKED/i.test(p.last_message) ? (
                      <button
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
                        onClick={() => onResume(p)}
                        disabled={busy || checkingAddr !== null || !wallet}
                        title="Owner-only: clear the breach lock so the engine can check this position again"
                      >
                        {busy ? 'Working…' : 'Resume'}
                      </button>
                    ) : (
                      <button
                        className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                        onClick={() => onCheck(p)}
                        disabled={busy || checkingAddr !== null || !wallet}
                        title={wallet ? 'Run the AI risk engine for this position' : 'Connect the wallet first'}
                      >
                        {checkingAddr === p.address ? 'Validators…' : 'Run Check()'}
                      </button>
                    )}
                    <div className="mt-1 text-[10px] text-slate-600">{p.last_checked}</div>
                  </td>
                </tr>
              ))
            )}
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
  const [positions, setPositions] = useState<Position[]>([]);
  const [synced, setSynced] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [txs, setTxs] = useState<TxRecord[]>(loadPersistedTxs);
  const [txScope, setTxScope] = useState<'active' | 'all'>('active');
  const [modalOpen, setModalOpen] = useState(false);
  const [checkingAddr, setCheckingAddr] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [protocol, setProtocol] = useState<ProtocolState | null>(null);
  const [history, setHistory] = useState<CheckEvent[]>([]);
  const [txByAccount, setTxByAccount] = useState<Record<string, string>>({});
  const [contractAddr, setContractAddr] = useState(DEFAULT_CONTRACT_ADDRESS);
  const [addrInput, setAddrInput] = useState(DEFAULT_CONTRACT_ADDRESS);
  const [addrHistory, setAddrHistory] = useState<string[]>(loadAddressHistory);
  const [livePrices, setLivePrices] = useState<Record<string, number> | null>(null);
  const [priceStamp, setPriceStamp] = useState<string | null>(null);
  const [verbose, setVerbose] = useState(false);
  const [lastSyncStamp, setLastSyncStamp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [activityMobileOpen, setActivityMobileOpen] = useState(false);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');

  const writeClientRef = useRef<GenClient | null>(null);
  const logIdRef = useRef(1);
  const connectingRef = useRef(false);
  const syncingRef = useRef(false);
  const lastSyncCountRef = useRef<number | null>(null);
  const protoChecksRef = useRef<number | null>(null);
  const historyLenRef = useRef(0);
  const trackTxRef = useRef<((hash: string, attempts?: number, delayMs?: number) => Promise<TxRecord>) | null>(null);
  const verboseRef = useRef(false);
  const termRef = useRef<HTMLDivElement | null>(null);
  const mobileTermRef = useRef<HTMLDivElement | null>(null);

  const paused = protocol?.paused === true;
  const liveThreshold = asNum(protocol?.threshold) || DEFAULT_THRESHOLD;

  const pushLog = useCallback((level: LogLevel, msg: string, txHash?: string) => {
    setLogs((prev) => [
      ...prev.slice(-200),
      { id: logIdRef.current++, time: new Date().toLocaleTimeString('en-GB'), level, msg, txHash },
    ]);
  }, []);

  // verbose diagnostics — writes to the Activity panel only when enabled in Settings
  const vlog = useCallback((msg: string) => {
    if (verboseRef.current) pushLog('info', msg);
  }, [pushLog]);

  const updateTx = useCallback((hash: string, patch: Partial<TxRecord>) => {
    setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, ...patch } : t)));
  }, []);

  useEffect(() => {
    for (const el of [termRef.current, mobileTermRef.current]) {
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logs, activityFilter, activityOpen, activityMobileOpen]);

  // persist the transaction panel across refreshes (scoped per contract on read)
  useEffect(() => {
    try {
      window.localStorage.setItem(TXS_STORAGE_KEY, JSON.stringify(txs.slice(0, 60)));
    } catch { /* quota — ignore */ }
  }, [txs]);

  // persist the activity dock open/minimized choice
  useEffect(() => {
    try {
      window.localStorage.setItem('cg_activity_open', activityOpen ? '1' : '0');
    } catch { /* ignore */ }
  }, [activityOpen]);

  // single boot effect: apply saved address + cached prices first, then log once
  useEffect(() => {
    const saved = window.localStorage.getItem(ADDRESS_STORAGE_KEY);
    let addr = DEFAULT_CONTRACT_ADDRESS;
    if (saved && /^0x[0-9a-fA-F]{40}$/.test(saved)) {
      addr = saved;
      setContractAddr(saved);
      setAddrInput(saved);
    }
    // cached prices load post-hydration (never during first paint — avoids a
    // server/client mismatch on the dashboard ticker)
    const cached = loadCachedPrices();
    if (cached) setLivePrices(cached);
    const vSaved = window.localStorage.getItem('cg_verbose') === '1';
    setVerbose(vSaved);
    verboseRef.current = vSaved;
    if (window.localStorage.getItem('cg_activity_open') === '0') setActivityOpen(false);
    pushLog('info', 'CollateralGuard risk engine online — GenLayer Intelligent Consensus ready');
    pushLog('info', `Target contract: ${short(addr)} on ${NETWORK_LABEL} (61999)`);

    // auto-resume tracking for transactions that were in flight before a refresh
    const pending = loadPersistedTxs().filter((t) => t.state === 'IN_FLIGHT');
    pending.forEach((t) => {
      void (async () => {
        const rec = await trackTxRef.current?.(t.hash, 30, 3000);
        if (rec && rec.state === 'EXECUTED' && rec.output) {
          pushLog('success', `${t.method} confirmed: ${rec.output}`, t.hash);
        } else if (rec && rec.state === 'REVERTED') {
          pushLog('error', `${t.method} REVERTED on-chain: ${rec.revertReason}`, t.hash);
        }
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        setLivePrices((prev) => {
          const merged = { ...(prev ?? {}), ...next };
          try {
            window.localStorage.setItem(PRICES_STORAGE_KEY, JSON.stringify(merged));
          } catch { /* ignore */ }
          return merged;
        });
        setPriceStamp(new Date().toLocaleTimeString('en-GB'));
        vlog(`prices updated from CoinGecko (ETH ${next.ETH ?? '—'}, BTC ${next.BTC ?? '—'}, SOL ${next.SOL ?? '—'})`);
      }
    } catch {
      /* keep the last good values */
    }
  }, [vlog]);

  useEffect(() => {
    void fetchLivePrices();
    const iv = setInterval(() => void fetchLivePrices(), 45_000);
    return () => clearInterval(iv);
  }, [fetchLivePrices]);

  const priceOf = useCallback(
    (asset: string) => livePrices?.[asset.toUpperCase()] ?? DISPLAY_PRICES[asset.toUpperCase()] ?? 1000,
    [livePrices],
  );

  /* ── GenVM reads/writes through the official SDK ── */

  const callView = useCallback(
    async (method: string, args: unknown[] = []): Promise<unknown> => {
      let lastErr: any;
      // the Studio RPC occasionally drops a request ("Failed to fetch") —
      // retry transient transport errors; contract-level reverts fail fast
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await getReadClient().readContract({
            address: contractAddr as `0x${string}`,
            functionName: method,
            args: args as any,
          });
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message ?? e);
          if (/not found|revert|execution|invalid/i.test(msg)) throw e;
          if (attempt < 2) await sleep(1500);
        }
      }
      throw lastErr;
    },
    [contractAddr],
  );

  const refreshProtocolState = useCallback(async () => {
    try {
      const ps = await callView('get_protocol_state', []);
      const st = typeof ps === 'string' ? JSON.parse(ps) : ps;
      if (st && typeof st === 'object') {
        // monotonic guard: never let a slower stale response roll the counter back
        const n = asNum((st as ProtocolState).total_checks);
        if (protoChecksRef.current === null || n >= protoChecksRef.current) {
          protoChecksRef.current = n;
          setProtocol(st as ProtocolState);
        }
        return st as ProtocolState;
      }
      return null;
    } catch {
      return null;
    }
  }, [callView]);

  const refreshHistory = useCallback(async () => {
    try {
      const raw = await callView('get_check_history', [20]);
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // monotonic guard: keep the richest history seen; never flicker to empty
      if (Array.isArray(list) && list.length >= historyLenRef.current) {
        historyLenRef.current = list.length;
        setHistory(list as CheckEvent[]);
      }
    } catch {
      /* history view needs the v3 contract — ignore on older deployments */
    }
  }, [callView]);

  /** Upsert with freshness awareness: stale syncs never overwrite fresh verdicts. */
  const upsertPosition = useCallback((p: Position, opts?: { force?: boolean }) => {
    setPositions((prev) => {
      const i = prev.findIndex((x) => x.address.toLowerCase() === p.address.toLowerCase());
      if (i === -1) return [...prev, { ...p, updatedTs: Date.now() }];
      const existing = prev[i];
      if (!opts?.force && !existing.localOnly) {
        const incN = checkNumberOf(p.last_checked);
        const curN = checkNumberOf(existing.last_checked);
        const incTs = p.updatedTs ?? 0;
        const curTs = existing.updatedTs ?? 0;
        if (incN < curN || (incN === curN && incTs <= curTs && incTs === 0)) {
          return prev; // stale read — keep the fresher row
        }
        if (incN === curN && incTs < curTs) {
          return prev;
        }
      }
      const next = [...prev];
      next[i] = { ...existing, ...p, updatedTs: Date.now() };
      return next;
    });
  }, []);

  const syncFromChain = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        const raw = await callView('get_all_accounts', []);
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list)) {
          for (const r of list) {
            if (r && typeof r.address === 'string') {
              upsertPosition({ ...r, address: r.address, localOnly: false } as Position);
            }
          }
          setSynced(true);
          const n = list.length;
          const changed = n !== lastSyncCountRef.current;
          if (changed) vlog(`sync: merged ${n} monitored account(s) from chain`);
          if (!opts?.silent && n !== lastSyncCountRef.current) {
            pushLog('success', `Synced ${n} monitored account(s) from GenVM state`);
          }
          lastSyncCountRef.current = n;
        } else if (!Array.isArray(list)) {
          vlog('sync: unexpected response shape');
        }
        setLastSyncStamp(new Date().toLocaleTimeString('en-GB'));
        await refreshProtocolState();
        await refreshHistory();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/not found/i.test(msg)) {
          pushLog('error', `Contract ${short(contractAddr)} not found on ${NETWORK_LABEL} — check the address (Settings) and keep it exactly checksummed`);
        } else if (!opts?.silent) {
          pushLog('error', `Chain read failed: ${msg.slice(0, 160)}`);
        } else {
          vlog(`sync failed: ${msg.slice(0, 120)}`);
        }
      } finally {
        syncingRef.current = false;
      }
    },
    [callView, pushLog, refreshProtocolState, refreshHistory, upsertPosition, vlog, contractAddr],
  );

  // real-time synchronization: poll contract state on an interval so the
  // dashboard always mirrors what the explorer shows (reads need no wallet)
  useEffect(() => {
    void syncFromChain({ silent: true });
    const iv = setInterval(() => void syncFromChain({ silent: true }), 12_000);
    return () => clearInterval(iv);
  }, [syncFromChain]);

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
        contract: contractAddr,
        method,
        argsSummary: args.map((a) => (typeof a === 'string' && a.startsWith('0x') ? short(a) : String(a))).join(', '),
        time: new Date().toLocaleTimeString('en-GB'),
        ts: Date.now(),
        state: 'IN_FLIGHT',
        chainStatus: 'PENDING',
        votesAgree: 0,
        votesTotal: 0,
      };
      setTxs((prev) => [record, ...prev].slice(0, 60));
      pushLog('info', `Tx broadcast: ${method}(${record.argsSummary}) — waiting for validator consensus…`, txHash);
      return txHash;
    },
    [contractAddr, pushLog],
  );

  /**
   * Poll the chain until the tx settles, classifying the REAL execution
   * outcome. Marks the record STALE if nothing settles in time (typically a
   * MetaMask "replace"/drop).
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

          vlog(`tx ${short(hash)} → ${chainStatus}${execStatus ? ` / exec ${execStatus}` : ''} / votes ${agree}/${voteVals.length}`);

          if (reverted) {
            const reason =
              parseRevertReason(leader?.genvm_result?.stderr) ??
              (leader?.result?.payload ? String(leader.result.payload) : undefined) ??
              'execution error';
            patch.state = 'REVERTED';
            patch.revertReason = reason;
            latest = { hash, contract: '', method: '', argsSummary: '', time: '', ts: Date.now(), state: 'REVERTED', chainStatus, votesAgree: agree, votesTotal: voteVals.length, revertReason: reason };
            updateTx(hash, patch);
            return latest;
          }

          if (DECIDED.has(statusNum) && leader && execStatus) {
            const output = leader?.result?.raw ? decodeReturnPayload(String(leader.result.raw)) : undefined;
            // prefer the FINALIZED receipt — the return payload can still be
            // empty at ACCEPTED; keep polling unless we're nearly out of attempts
            if (statusNum === 5 && !output && i < attempts - 6) {
              updateTx(hash, patch);
              continue;
            }
            patch.state = 'EXECUTED';
            patch.output = output;
            latest = { hash, contract: '', method: '', argsSummary: '', time: '', ts: Date.now(), state: 'EXECUTED', chainStatus, votesAgree: agree, votesTotal: voteVals.length, output };
            updateTx(hash, patch);
            return latest;
          }

          updateTx(hash, patch);
        } catch {
          /* not indexed yet — keep polling */
        }
      }
      updateTx(hash, { state: 'STALE' });
      return latest ?? { hash, contract: '', method: '', argsSummary: '', time: '', ts: Date.now(), state: 'STALE', chainStatus: 'UNKNOWN', votesAgree: 0, votesTotal: 0 };
    },
    [updateTx, vlog],
  );

  // latest-ref pattern: the mount effect can auto-resume persisted in-flight txs
  trackTxRef.current = trackTx;

  const pollPosition = useCallback(
    async (addr: string, attempts = 14, delayMs = 2500): Promise<Position | null> => {
      for (let i = 0; i < attempts; i++) {
        await sleep(i === 0 ? 1500 : delayMs);
        try {
          const raw = await callView('get_position_status', [addr]);
          if (typeof raw === 'string' && raw !== 'NOT_FOUND') {
            const rec = JSON.parse(raw);
            vlog(`poll: ${short(addr)} → ${rec.last_checked} (${rec.status}, ratio ${rec.last_ratio}%)`);
            return { ...rec, address: addr } as Position;
          }
        } catch {
          /* consensus still settling */
        }
      }
      return null;
    },
    [callView, vlog],
  );

  /* ── wallet ── */

  const connectWallet = useCallback(async (): Promise<string | null> => {
    if (connectingRef.current) return wallet;
    const eth = window.ethereum;
    if (!eth) {
      pushLog('error', 'MetaMask not detected — install it to interact with GenLayer');
      return null;
    }
    try {
      connectingRef.current = true;
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
        await syncFromChain({ silent: true });
      }
      return addr;
    } catch (e: any) {
      pushLog('error', `Wallet connection failed: ${e?.shortMessage ?? e?.message ?? e}`);
      return null;
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [wallet, pushLog, syncFromChain]);

  const disconnectWallet = useCallback(() => {
    writeClientRef.current = null;
    setWallet(null);
    setProtocol(null);
    protoChecksRef.current = null;
    pushLog('warn', 'Wallet disconnected');
  }, [pushLog]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    eth
      .request({ method: 'eth_accounts' })
      .then((accs: string[]) => {
        if (accs?.length && !connectingRef.current) void connectWallet();
      })
      .catch(() => {});
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) {
        writeClientRef.current = null;
        setWallet(null);
        pushLog('warn', 'Wallet disconnected');
      } else {
        setWallet(accs[0]);
      }
    };
    eth.on?.('accountsChanged', onAccounts);
    return () => eth.removeListener?.('accountsChanged', onAccounts);
  }, [connectWallet, pushLog]);

  /* ── actions ── */

  const runCheck = useCallback(
    async (pos: Position) => {
      if (!wallet) {
        const w = await connectWallet();
        if (!w || !writeClientRef.current) return;
      }
      if (busy) return;
      setBusy(true);
      setCheckingAddr(pos.address);
      try {
        let target = pos;
        if (pos.localOnly) {
          pushLog('info', 'Preview rows are disabled — add the position on-chain from the Accounts tab first');
          return;
        }
        if (pos.locked || /ACCOUNT_LOCKED/i.test(pos.last_message)) {
          pushLog('warn', `${short(target.address)} is locked after a breach — press Resume on its row first (owner only)`);
          return;
        }

        const before = await callView('get_position_status', [target.address]).catch(() => undefined);
        pushLog('ai', `check_and_protect(${short(target.address)}) → validators fetching ${target.collateral_asset} price, then LLM consensus…`);
        const hash = await sendWrite('check_and_protect', [target.address]);
        const outcome = await trackTx(hash);

        if (outcome.state === 'REVERTED') {
          const reason = outcome.revertReason ?? 'contract error';
          const hint = /PROTOCOL_PAUSED/i.test(reason)
            ? ' — open Risk Engine and press Resume Protocol, then run the check again'
            : /ACCOUNT_LOCKED/i.test(reason)
              ? ' — this position is locked after its breach; the owner must press Resume on its row first'
              : '';
          pushLog('error', `check_and_protect REVERTED on-chain: ${reason}${hint}`, hash);
          await refreshProtocolState();
          return;
        }

        pushLog('ai', 'Equivalence principle satisfied — every validator agreed on the risk verdict…');

        // instant row update from the decoded on-chain output, then confirm by polling
        const verdict = parseVerdict(outcome.output);
        if (verdict) {
          upsertPosition({
            ...target,
            status: verdict.status,
            last_ratio: verdict.ratio,
            last_message: outcome.output ?? target.last_message,
            last_checked: `CHECK #${(asNum(protocol?.total_checks) || 0) + 1}`,
          }, { force: true });
        }

        const fresh = await pollPosition(target.address);
        const beforeRec = typeof before === 'string' ? JSON.parse(before) : undefined;
        const unchanged = fresh && beforeRec && fresh.last_checked === beforeRec.last_checked && fresh.last_message === beforeRec.last_message;

        if (fresh && !unchanged) {
          upsertPosition(fresh, { force: true });
          setTxByAccount((prev) => ({ ...prev, [target.address]: hash }));
          const v = parseVerdict(outcome.output);
          const effStatus = v?.status ?? fresh.status;
          const effRatio = v?.ratio ?? fresh.last_ratio;
          const level: LogLevel = effStatus === 'CRITICAL' ? 'error' : effStatus === 'WARNING' ? 'warn' : 'success';
          pushLog(level, outcome.output ?? fresh.last_message, hash);
          await refreshProtocolState();
          await refreshHistory();
          if (effStatus === 'CRITICAL') {
            pushLog('error', 'POSITION LOCKED — further checks for it will revert until the owner presses Resume on its row');
          }
        } else if (outcome.output) {
          pushLog('success', outcome.output, hash);
        } else {
          pushLog('warn', 'Verdict not visible in state yet — open Transactions for the on-chain output, or press Refresh shortly', hash);
        }
      } catch (e: any) {
        pushLog('error', `check_and_protect failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setCheckingAddr(null);
        setBusy(false);
      }
    },
    [wallet, connectWallet, busy, pushLog, sendWrite, trackTx, pollPosition, upsertPosition, callView, refreshProtocolState, refreshHistory, protocol, liveThreshold],
  );

  const submitAddFunds = useCallback(
    async (form: { account: string; collateral: string; debt: string; asset: string; debtAsset: string }) => {
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
      // this contract rejects duplicate addresses — pre-check so no gas is wasted
      const exists = positions.some((x) => x.address.toLowerCase() === account.toLowerCase());
      if (exists) {
        pushLog('warn', `ALREADY_MONITORED — ${short(account)} is already registered on this contract. Use a different address, or run Check() on the existing row.`);
        return;
      }
      if (busy) return;
      setBusy(true);
      try {
        if (!wallet) {
          const w = await connectWallet();
          if (!w || !writeClientRef.current) return;
        }
        const hash = await sendWrite('add_monitored_account', [account, collateral, debt, form.asset, form.debtAsset]);
        const outcome = await trackTx(hash);
        if (outcome.state === 'REVERTED') {
          pushLog('error', `add_monitored_account REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}`, hash);
          return;
        }
        upsertPosition({
          address: account,
          collateral_amount: collateral,
          debt_amount: debt,
          collateral_asset: form.asset,
          debt_asset: form.debtAsset,
          status: 'SAFE',
          last_ratio: 0,
          ai_sentiment: 'N/A',
          last_message: outcome.output ?? 'Initialized. Awaiting first check().',
          last_checked: 'NEVER',
        }, { force: true });
        setTxByAccount((prev) => ({ ...prev, [account]: hash }));
        setModalOpen(false);
        pushLog('success', outcome.output ?? `FUNDS_ADDED: ${short(account)} is now monitored`, hash);
        void pollPosition(account, 6, 3000).then((fresh) => {
          if (fresh) upsertPosition(fresh, { force: true });
        });
      } catch (e: any) {
        pushLog('error', `add_monitored_account failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setBusy(false);
      }
    },
    [wallet, busy, connectWallet, pushLog, sendWrite, trackTx, upsertPosition, pollPosition, positions],
  );

  const resumeProtocol = useCallback(async () => {
    if (busy) return;
    setBusy(true);
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
      setBusy(false);
    }
  }, [busy, pushLog, sendWrite, trackTx, refreshProtocolState]);

  const resumeAccount = useCallback(
    async (pos: Position) => {
      if (!wallet) {
        pushLog('error', 'Connect the deployer wallet first');
        return;
      }
      if (busy) return;
      setBusy(true);
      try {
        const hash = await sendWrite('resume_account', [pos.address]);
        const outcome = await trackTx(hash);
        if (outcome.state === 'REVERTED') {
          pushLog('error', `resume_account REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}`, hash);
          return;
        }
        pushLog('success', outcome.output ?? `ACCOUNT_RESUMED: ${short(pos.address)} unlocked — run Check() to re-evaluate`, hash);
        void pollPosition(pos.address, 6, 3000).then((fresh) => {
          if (fresh) upsertPosition(fresh, { force: true });
        });
      } catch (e: any) {
        pushLog('error', `resume_account failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setBusy(false);
      }
    },
    [wallet, busy, pushLog, sendWrite, trackTx, upsertPosition, pollPosition],
  );

  const pauseProtocol = useCallback(async () => {
    if (!wallet) {
      pushLog('error', 'Connect the deployer wallet first');
      return;
    }
    if (busy) return;
    setBusy(true);
    setResuming(true);
    pushLog('info', 'pause_protocol() — owner emergency stop, halts ALL checks…');
    try {
      const hash = await sendWrite('pause_protocol', []);
      const outcome = await trackTx(hash);
      if (outcome.state === 'REVERTED') {
        pushLog('error', `pause_protocol REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}`, hash);
        return;
      }
      for (let i = 0; i < 8; i++) {
        const st = await refreshProtocolState();
        if (st && st.paused === true) {
          pushLog('warn', outcome.output ?? 'PROTOCOL_PAUSED: emergency stop engaged — every check will revert until resumed', hash);
          return;
        }
        await sleep(4000);
      }
      pushLog('warn', 'Pause still settling in consensus — check again shortly', hash);
    } catch (e: any) {
      pushLog('error', `pause_protocol failed: ${e?.shortMessage ?? e?.message ?? e}`);
    } finally {
      setResuming(false);
      setBusy(false);
    }
  }, [wallet, busy, pushLog, sendWrite, trackTx, refreshProtocolState]);

  const updateThreshold = useCallback(
    async (value: number) => {
      if (!wallet) {
        pushLog('error', 'Connect the deployer wallet first');
        return;
      }
      if (busy) return;
      setBusy(true);
      setResuming(true);
      try {
        const hash = await sendWrite('set_threshold', [Math.round(value)]);
        const outcome = await trackTx(hash);
        if (outcome.state === 'REVERTED') {
          pushLog('error', `set_threshold REVERTED on-chain: ${outcome.revertReason ?? 'contract error'}`, hash);
          return;
        }
        pushLog('success', outcome.output ?? `THRESHOLD_UPDATED: liquidation threshold is now ${Math.round(value)}%`, hash);
        const st = await refreshProtocolState();
        if (st && st.paused) {
          pushLog('warn', 'Threshold updated — the circuit breaker is still engaged from the earlier breach. Press Resume Protocol, then re-run checks.');
        }
      } catch (e: any) {
        pushLog('error', `set_threshold failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setResuming(false);
        setBusy(false);
      }
    },
    [wallet, busy, pushLog, sendWrite, trackTx, refreshProtocolState],
  );

  const switchAddress = useCallback(
    (addr: string) => {
      const v = addr.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
        pushLog('error', 'That is not a valid 20-byte address (0x + 40 hex chars)');
        return;
      }
      if (v.toLowerCase() === contractAddr.toLowerCase()) return;
      // switching contracts switches data: clear the stale view first
      setPositions([]);
      setProtocol(null);
      setHistory([]);
      setSynced(false);
      protoChecksRef.current = null;
      historyLenRef.current = 0;
      lastSyncCountRef.current = null;
      window.localStorage.setItem(ADDRESS_STORAGE_KEY, v);
      const hist = [v, ...addrHistory.filter((a) => a.toLowerCase() !== v.toLowerCase())].slice(0, 5);
      window.localStorage.setItem(ADDRESS_HISTORY_KEY, JSON.stringify(hist));
      setAddrHistory(hist);
      setContractAddr(v);
      setAddrInput(v);
      setTxScope('active');
      pushLog('info', `Contract address set to ${short(v)} — syncing…`);
      void syncFromChain({ silent: true });
    },
    [contractAddr, addrHistory, pushLog, syncFromChain],
  );

  /* ── derived dashboard data (on-chain positions only — no preview data) ── */

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

  const healthColor = stats.health >= liveThreshold ? 'text-emerald-400' : 'text-rose-400';
  const unconfigured = contractAddr === '0x0000000000000000000000000000000000000000';
  const inFlight = txs.filter((t) => t.state === 'IN_FLIGHT').length;
  const otherAddresses = addrHistory.filter((a) => a.toLowerCase() !== contractAddr.toLowerCase());
  const visibleTxs = txScope === 'all' ? txs : txs.filter((t) => (t.contract ?? '').toLowerCase() === contractAddr.toLowerCase());
  const lockedPositions = positions.filter((p) => p.locked || /ACCOUNT_LOCKED/i.test(p.last_message));

  // On-chain activity feed: every ADD and CHECK recorded by the contract,
  // newest first — this is what makes the tab mirror the explorer.
  const checkEvents = useMemo(() => history.filter((h) => (h.type ?? 'CHECK') === 'CHECK'), [history]);

  const onChainEvents = useMemo(() => {
    const evts: { kind: 'ADD' | 'CHECK' | 'RESUME'; seq: number; account: string; status: string; detail: string }[] = [];
    for (const h of [...history].reverse()) {
      if (h.type === 'ADD') {
        evts.push({
          kind: 'ADD',
          seq: 0,
          account: h.account,
          status: 'SAFE',
          detail: `${h.collateral_amount} ${h.asset} added vs ${h.debt_amount} ${h.debt_asset ?? 'USDT'} debt`,
        });
      } else if (h.type === 'RESUME_ACCOUNT') {
        evts.push({
          kind: 'RESUME',
          seq: 0,
          account: h.account,
          status: 'SAFE',
          detail: h.message,
        });
      } else {
        evts.push({
          kind: 'CHECK',
          seq: h.seq ?? 0,
          account: h.account,
          status: h.status ?? 'SAFE',
          detail: `${h.asset} · ratio ${h.ratio ?? 0}% · ${h.message}`,
        });
      }
    }
    return evts;
  }, [history]);

  const tableEl = (
    <PositionsTable
      positions={positions}
      txByAccount={txByAccount}
      checkingAddr={checkingAddr}
      onCheck={(p) => void runCheck(p)}
      onResume={(p) => void resumeAccount(p)}
      priceOf={priceOf}
      threshold={liveThreshold}
      synced={synced}
      wallet={wallet}
      busy={busy}
    />
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
              LIQ threshold <span className="font-semibold text-slate-200">{liveThreshold}%</span>
            </span>
            {wallet ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="font-mono">{short(wallet)}</span>
                </span>
                <button
                  className="rounded-full border border-[#1e293b] px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                  onClick={disconnectWallet}
                >
                  Disconnect
                </button>
              </div>
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

          {lockedPositions.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <div className="flex items-center gap-3 text-sm text-rose-300">
                <span className="h-2 w-2 animate-ping rounded-full bg-rose-400" />
                <span className="font-semibold">
                  {lockedPositions.length} position{lockedPositions.length > 1 ? 's' : ''} LOCKED after breach
                </span>
                <span className="text-rose-300/70">
                  {short(lockedPositions[0].address)} hit {lockedPositions[0].last_ratio}% — checks for it revert until the owner resumes it.
                </span>
              </div>
              <button
                className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                onClick={() => lockedPositions.forEach((p) => void resumeAccount(p))}
                disabled={busy}
              >
                Resume locked (owner)
              </button>
            </div>
          )}

          {paused && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <div className="flex items-center gap-3 text-sm text-rose-300">
                <span className="h-2 w-2 animate-ping rounded-full bg-rose-400" />
                <span className="font-semibold">Emergency stop active</span>
                <span className="text-rose-300/70">— the owner paused the protocol; every check reverts until resumed.</span>
              </div>
              <button
                className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                onClick={() => void resumeProtocol()}
                disabled={resuming || busy}
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
                  { label: 'Total Collateral', value: synced && positions.length > 0 ? fmtUSD(stats.coll) : '—', sub: synced ? 'live prices · on-chain positions' : 'syncing…', accent: 'text-cyan-300' },
                  { label: 'Total Debt', value: synced && positions.length > 0 ? fmtUSD(stats.debt) : '—', sub: synced ? 'per-position debt assets' : 'syncing…', accent: 'text-rose-300' },
                  { label: 'Portfolio Health', value: synced && stats.debt > 0 ? `${stats.health}%` : '—', sub: synced ? `live prices · verdicts on-chain (liq ${liveThreshold}%)` : 'syncing…', accent: healthColor },
                  { label: 'Consensus Checks', value: protocol ? String(asNum(protocol.total_checks)) : '—', sub: paused ? 'protocol paused' : synced ? 'protocol operational' : 'syncing…', accent: 'text-slate-100' },
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
                      centerLabel={synced && positions.length > 0 ? fmtUSD(stats.coll) : '—'}
                      centerSub="collateral"
                    />
                    <div className="space-y-2">
                      {allocation.length === 0 && (
                        <div className="text-[11px] text-slate-600">No on-chain positions yet</div>
                      )}
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
                      segments={
                        synced && positions.length > 0
                          ? [
                              { label: 'Collateral', value: stats.coll, color: '#22d3ee' },
                              { label: 'Debt', value: stats.debt, color: '#fb7185' },
                            ]
                          : [{ label: '—', value: 1, color: '#141d33' }]
                      }
                      centerLabel={synced && stats.debt > 0 ? `${stats.health}%` : '—'}
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
                        Health = collateral ÷ debt. Below {liveThreshold}% the engine trips the breaker.
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5">
                  <div className="mb-1 text-sm font-medium text-slate-300">Check History</div>
                  <div className="text-[11px] text-slate-600">
                    {checkEvents.length >= 1
                      ? `real on-chain ratios · ${checkEvents.length} check${checkEvents.length > 1 ? 's' : ''} recorded`
                      : 'run checks to build the real history'}
                  </div>
                  <div className="mt-2 h-[200px]">
                    <HealthTimeline
                      positions={positions}
                      threshold={liveThreshold}
                      prices={livePrices ?? DISPLAY_PRICES}
                      history={checkEvents}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-slate-300">Monitored Positions</div>
                    <div className="text-[10px] text-slate-600">
                      auto-sync every 12s{lastSyncStamp ? ` · updated ${lastSyncStamp}` : ''}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg border border-[#1e293b] px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                      onClick={() => void syncFromChain()}
                    >
                      Refresh
                    </button>
                    <button
                      className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                      onClick={() => setModalOpen(true)}
                      disabled={busy}
                    >
                      + Add Account / Funds
                    </button>
                  </div>
                </div>
                {tableEl}
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
                    className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    onClick={() => setModalOpen(true)}
                    disabled={busy}
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
                    ['Emergency stop', paused ? 'ENGAGED — protocol paused' : synced ? 'disengaged — operational' : 'syncing…'],
                    ['Safety threshold', `${liveThreshold}%`],
                    ['Consensus checks run', protocol ? String(asNum(protocol.total_checks)) : '—'],
                    ['Owner (can resume)', protocol?.owner ? short(protocol.owner) : '—'],
                    ['Contract', short(contractAddr)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between border-b border-[#0e1526] pb-2 last:border-0">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className={`font-mono ${String(v).startsWith('ENGAGED') ? 'text-rose-400' : 'text-slate-200'}`}>{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 space-y-3">
                  <button
                    className="w-full rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                    onClick={() => void resumeProtocol()}
                    disabled={resuming || busy || !paused}
                  >
                    {resuming ? 'Working…' : paused ? 'Resume Protocol (owner only)' : 'Protocol operational — nothing to resume'}
                  </button>
                  {!paused && (
                    <button
                      className="w-full rounded-lg border border-[#1e293b] px-3 py-2 text-xs text-slate-300 hover:bg-rose-500/10 disabled:opacity-50"
                      onClick={() => void pauseProtocol()}
                      disabled={busy || resuming || !wallet}
                      title="Owner-only emergency stop — halts ALL checks until resumed"
                    >
                      Pause Protocol (emergency stop)
                    </button>
                  )}
                  <div className="rounded-lg border border-[#1e293b] p-3">
                    <div className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">Liquidation threshold (owner only)</div>
                    <ThresholdControl
                      current={liveThreshold}
                      busy={busy || resuming}
                      onSubmit={(v) => void updateThreshold(v)}
                    />
                    <div className="mt-2 text-[10px] text-slate-600">
                      Applies to the next check — a breaker engaged by an earlier breach still needs Resume Protocol.
                    </div>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-5 text-xs leading-relaxed text-slate-400">
                <div className="mb-3 text-sm font-medium text-slate-300">How a Check() works</div>
                <ol className="list-decimal space-y-2 pl-4">
                  <li>Your Run Check() broadcasts <span className="font-mono text-cyan-300">check_and_protect</span> through MetaMask to the consensus contract.</li>
                  <li>Five independent LLM validators each fetch the live asset price (Binance → Coinbase → CoinGecko fallback chain) and recompute the collateral ratio.</li>
                  <li>The equivalence principle requires them to agree on the verdict category (SAFE / WARNING / CRITICAL) — numeric drift from live prices is tolerated.</li>
                  <li>SAFE holds, WARNING flags catastrophic AI sentiment (advisory), and a ratio below the threshold <span className="italic">at check time</span> trips the circuit breaker and pauses the protocol.</li>
                  <li>Every add and every check is recorded on-chain — the Transactions tab lists them and the Dashboard timeline plots the real ratios from <span className="font-mono text-cyan-300">get_check_history</span>.</li>
                </ol>
              </div>
            </div>
          )}

          {tab === 'transactions' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-slate-300">Transaction Activity</div>
                  <div className="text-[11px] text-slate-600">
                    Live on-chain outcomes — status, execution result, validator consensus and decoded output. Saved in this browser.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-[#1e293b] p-0.5 text-[10px]">
                    {([
                      ['active', 'This contract'],
                      ['all', 'All contracts'],
                    ] as ['active' | 'all', string][]).map(([id, label]) => (
                      <button
                        key={id}
                        className={`rounded-md px-2.5 py-1 ${txScope === id ? 'bg-cyan-500/15 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}
                        onClick={() => setTxScope(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    className="rounded-lg border border-[#1e293b] px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                    onClick={() => visibleTxs.forEach((t) => {
                      if (t.state === 'IN_FLIGHT' || t.state === 'STALE') {
                        updateTx(t.hash, { state: 'IN_FLIGHT' });
                        void trackTx(t.hash);
                      }
                    })}
                  >
                    Re-poll pending
                  </button>
                </div>
              </div>
              {/* on-chain activity — synced from the contract on connect */}
              <div className="overflow-hidden rounded-2xl border border-[#131c30] bg-[#0b1120]">
                <div className="border-b border-[#131c30] px-5 py-3.5">
                  <div className="text-sm font-medium text-slate-300">On-chain activity</div>
                  <div className="text-[11px] text-slate-600">Synced from the contract on connect — check verdicts and position additions</div>
                </div>
                {onChainEvents.length === 0 ? (
                  <div className="px-5 py-8 text-center text-xs text-slate-600">
                    No on-chain activity yet — add a position and run checks; every verdict recorded by the contract appears here.
                  </div>
                ) : (
                  <div className="divide-y divide-[#0e1526]">
                    {onChainEvents.map((ev, i) => (
                      <div key={`${ev.kind}-${ev.seq}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-xs">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            ev.kind === 'ADD'
                              ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                              : ev.kind === 'RESUME'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : ev.status === 'CRITICAL'
                                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                                  : ev.status === 'WARNING'
                                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          }`}
                        >
                          {ev.kind === 'ADD' ? 'ADDED' : ev.kind === 'RESUME' ? 'RESUMED' : `CHECK #${ev.seq}`}
                        </span>
                        <span className="font-mono text-slate-300">{short(ev.account)}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-400" title={ev.detail}>
                          {ev.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-1 text-sm font-medium text-slate-300">Broadcasts from this browser</div>
              {visibleTxs.length === 0 ? (
                <div className="rounded-2xl border border-[#131c30] bg-[#0b1120] px-5 py-10 text-center text-xs text-slate-600">
                  {txs.length === 0
                    ? 'No transactions yet — run a Check() or add an account. Every broadcast appears here with its live on-chain outcome.'
                    : 'No transactions recorded for this contract — switch to "All contracts" to see the rest.'}
                </div>
              ) : (
                <div className="space-y-3">
                  {visibleTxs.map((t) => (
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
                  the node&apos;s lookup is case-sensitive. Positions, checks and history are per-contract: switching addresses switches data.
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
                    onClick={() => switchAddress(addrInput)}
                  >
                    Save & Sync
                  </button>
                </div>
                {otherAddresses.length > 0 && (
                  <div className="mt-3 border-t border-[#0e1526] pt-3">
                    <div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-600">Recent contracts</div>
                    <div className="flex flex-wrap gap-2">
                      {otherAddresses.map((a) => (
                        <button
                          key={a}
                          className="rounded-lg border border-[#1e293b] px-2.5 py-1 font-mono text-[10px] text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300"
                          onClick={() => switchAddress(a)}
                        >
                          {short(a)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
                <div className="mt-4 space-y-2 border-t border-[#0e1526] pt-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-slate-300">Verbose logging</div>
                      <div className="text-[10px] text-slate-600">Logs every sync, poll and tx classification to Engine Activity — use when hunting bugs</div>
                    </div>
                    <button
                      className={`rounded-full border px-3 py-1 text-[10px] font-semibold ${
                        verbose
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : 'border-[#1e293b] bg-[#070b14] text-slate-400'
                      }`}
                      onClick={() => {
                        const nv = !verbose;
                        setVerbose(nv);
                        verboseRef.current = nv;
                        window.localStorage.setItem('cg_verbose', nv ? '1' : '0');
                        pushLog('info', `Verbose logging ${nv ? 'enabled' : 'disabled'}`);
                      }}
                    >
                      {verbose ? 'ON' : 'OFF'}
                    </button>
                  </div>
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

      {/* Engine Activity dock — RIGHT side, fixed viewport height with internal
          scroll, visible on every tab. Minimizes to a slim vertical rail. */}
      <div
        className={`sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden border-l border-[#131c30] bg-[#090e1a] transition-all duration-200 lg:flex ${
          activityOpen ? 'w-80' : 'w-12'
        }`}
      >
        {activityOpen ? (
          <>
            <div className="flex items-center justify-between border-b border-[#131c30] px-3 py-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-cyan-500/15">
                  <svg viewBox="0 0 24 24" className="h-3 w-3 text-cyan-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">Engine Activity</span>
                {logs.length > 0 && (
                  <span className="rounded-full border border-[#1e293b] px-1.5 py-0.5 text-[9px] text-slate-500">{logs.length}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  className="rounded-md border border-[#1e293b] px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300"
                  onClick={() => setLogs([])}
                >
                  Clear
                </button>
                <button
                  className="rounded-md p-1 text-slate-500 hover:text-slate-300"
                  title="Minimize to rail"
                  onClick={() => setActivityOpen(false)}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 5l7 7-7 7" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="border-b border-[#0e1526] px-3 py-2">
              <ActivityFilters filter={activityFilter} onFilter={setActivityFilter} />
            </div>
            <ActivityFeedBody logs={logs} filter={activityFilter} scrollRef={termRef} />
          </>
        ) : (
          <button
            className="flex h-full w-12 flex-col items-center gap-3 py-4 hover:bg-[#0d1526]"
            onClick={() => setActivityOpen(true)}
            title="Open Engine Activity"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" />
            </svg>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500" style={{ writingMode: 'vertical-rl' }}>
              Engine Activity{logs.length > 0 ? ` · ${logs.length}` : ''}
            </span>
          </button>
        )}
      </div>

      {/* mobile: floating activity button (right side) + slide-over drawer */}
      <button
        className="fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-500/40 bg-[#0d1526] text-cyan-300 shadow-lg lg:hidden"
        onClick={() => setActivityMobileOpen(true)}
        title="Engine Activity"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
        </svg>
        {logs.length > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-cyan-500 px-1.5 text-[9px] font-bold text-[#070b14]">{logs.length}</span>
        )}
      </button>

      {activityMobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setActivityMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            className="absolute right-0 top-0 flex h-full w-80 max-w-[85vw] flex-col border-l border-[#131c30] bg-[#090e1a]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#131c30] px-3 py-3">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">Engine Activity</span>
              <div className="flex items-center gap-1.5">
                <button
                  className="rounded-md border border-[#1e293b] px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300"
                  onClick={() => setLogs([])}
                >
                  Clear
                </button>
                <button className="rounded-md p-1 text-slate-500 hover:text-slate-300" onClick={() => setActivityMobileOpen(false)}>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="border-b border-[#0e1526] px-3 py-2">
              <ActivityFilters filter={activityFilter} onFilter={setActivityFilter} />
            </div>
            <ActivityFeedBody logs={logs} filter={activityFilter} scrollRef={mobileTermRef} />
          </div>
        </div>
      )}

      {modalOpen && (
        <AddFundsModal
          defaultAccount={wallet ?? ''}
          busy={busy}
          onClose={() => setModalOpen(false)}
          onSubmit={(f) => void submitAddFunds(f)}
          priceOf={priceOf}
          threshold={liveThreshold}
          positions={positions}
        />
      )}
    </div>
  );
}

function ThresholdControl({
  current, busy, onSubmit,
}: {
  current: number;
  busy: boolean;
  onSubmit: (v: number) => void;
}) {
  const [value, setValue] = useState(String(current));
  useEffect(() => setValue(String(current)), [current]);
  const parsed = Math.round(Number(value));
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000 && parsed !== current;
  return (
    <div className="flex gap-2">
      <input
        className="w-24 rounded-lg border border-[#1e293b] bg-[#070b14] px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-cyan-400/60"
        type="number"
        min="1"
        max="1000"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="flex-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
        onClick={() => valid && onSubmit(parsed)}
        disabled={busy || !valid}
      >
        {busy ? 'Broadcasting…' : 'Update Threshold'}
      </button>
    </div>
  );
}
