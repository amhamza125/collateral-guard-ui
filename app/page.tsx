'use client';

/**
 * CollateralGuard — DeFi Risk Engine ("Cryzen" design language)
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP
 *   1. npm install genlayer-js   (the official SDK — no ethers, no hand-rolled
 *      calldata encoding; the SDK handles GenVM calldata/RLP + receipts natively)
 *   2. Contract is preconfigured to the deployed CollateralGuard on Studionet
 *      (chain ID 61999). To point at a different deployment, set
 *      NEXT_PUBLIC_GUARD_ADDRESS in .env.local and restart the dev server.
 *   3. Deploy to Vercel as usual — all chain calls run client-side.
 *
 * WHY THE SDK (hard-won): calling GenLayer through raw ethers v6 crashes on
 * tx.wait() (GenVM receipts are not EVM receipts → BAD_DATA), and GenVM
 * calldata is not Solidity ABI. genlayer-js handles both, exposes
 * waitForTransactionReceipt with real GenLayer tx statuses, and its
 * readContract/writeContract take plain functionName + args.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { ExecutionResult, TransactionStatus } from 'genlayer-js/types';

declare global {
  interface Window {
    ethereum?: any;
  }
}

/* ─────────────────────────────── CONFIG ─────────────────────────────── */

// Deployed CollateralGuard on GenLayer Studionet (chain ID 61999).
const CONTRACT_ADDRESS = (
  process.env.NEXT_PUBLIC_GUARD_ADDRESS ?? '0xaCBd7A2861E5f41276F17ffCF0881906798988C4'
).toLowerCase() as `0x${string}`;

const NETWORK_LABEL = 'GenLayer Studionet';
const EXPLORER_TX = 'https://explorer-studio.genlayer.com/tx/';
const THRESHOLD = 150;

// Display-only spot prices for the dashboard charts. The contract itself
// fetches the live price from Binance inside the consensus flow during check().
const DISPLAY_PRICES: Record<string, number> = { ETH: 3200, BTC: 64000, SOL: 150 };
const ASSET_COLORS: Record<string, string> = { ETH: '#627eea', BTC: '#f7931a', SOL: '#14f195' };

type GenClient = ReturnType<typeof createClient>;

// Read client talks straight to the GenLayer RPC — no wallet needed.
let readClientSingleton: GenClient | null = null;
function getReadClient(): GenClient {
  if (!readClientSingleton) readClientSingleton = createClient({ chain: studionet });
  return readClientSingleton;
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
  price_source?: string;
  last_message: string;
  last_checked: string;
  localOnly?: boolean;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEED_POSITIONS: Position[] = [
  {
    address: '0x9ab41c7d5f3a92e0b6d18c4a77e2f9d0c5b8a3e1',
    collateral_amount: 40, debt_amount: 60000, collateral_asset: 'ETH', debt_asset: 'USDT',
    status: 'SAFE', last_ratio: 213, ai_sentiment: 'NEUTRAL', price_source: 'LIVE',
    last_message: 'RATIO_SAFE_CONDITION_HELD: ratio 213% is healthy — AI sentiment is NEUTRAL',
    last_checked: 'CHECK #12', localOnly: true,
  },
  {
    address: '0x1c7d9f02e5a4b8306d91c7f5a2e8b4d0f3a6c9e2',
    collateral_amount: 10, debt_amount: 400000, collateral_asset: 'BTC', debt_asset: 'USDT',
    status: 'WARNING', last_ratio: 160, ai_sentiment: 'CATASTROPHIC', price_source: 'LIVE',
    last_message: 'AI_CONSENSUS_WARNING: ratio 160% held, but AI consensus detected catastrophic market sentiment',
    last_checked: 'CHECK #13', localOnly: true,
  },
  {
    address: '0xf3a902b7c4d1e6f8a5b3c2d9e7f4a1b6c8d0e3f5',
    collateral_amount: 300, debt_amount: 70000, collateral_asset: 'SOL', debt_asset: 'USDT',
    status: 'CRITICAL', last_ratio: 64, ai_sentiment: 'NEUTRAL', price_source: 'FALLBACK',
    last_message: 'CRITICAL_BREACH: ratio 64% < 150% — CIRCUIT_BREAKER_ENGAGED, protocol paused',
    last_checked: 'CHECK #14', localOnly: true,
  },
];

const STATUS_STYLES: Record<Position['status'], string> = {
  SAFE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  WARNING: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  CRITICAL: 'bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse',
};

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

function HealthTimeline({ positions, threshold }: { positions: Position[]; threshold: number }) {
  const series = useMemo(() => {
    const coll = positions.reduce((s, p) => s + p.collateral_amount * (DISPLAY_PRICES[p.collateral_asset] ?? 1000), 0);
    const debt = Math.max(1, positions.reduce((s, p) => s + p.debt_amount, 0));
    const current = Math.min(340, Math.max(90, Math.round((coll * 100) / debt)));
    // deterministic pseudo-random walk — same picture on every render
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
  }, [positions]);

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

function Sidebar({ wallet }: { wallet: string | null }) {
  const nav = [
    { label: 'Dashboard', active: true, d: 'M3 12l9-8 9 8M5 10v10h14V10' },
    { label: 'Accounts', active: false, d: 'M4 6h16M4 12h16M4 18h10' },
    { label: 'Risk Engine', active: false, d: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z' },
    { label: 'History', active: false, d: 'M12 8v5l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { label: 'Settings', active: false, d: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2L14 21h-4l-.5-2.6a7 7 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 015 12' },
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
          <div
            key={n.label}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${
              n.active
                ? 'border border-[#1b2b47] bg-[#0d1526] text-cyan-300'
                : 'text-slate-500 hover:bg-[#0d1526] hover:text-slate-300'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={n.d} />
            </svg>
            {n.label}
          </div>
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

/* ─────────────────────────────── PAGE ───────────────────────────────── */

export default function Page() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [positions, setPositions] = useState<Position[]>(SEED_POSITIONS);
  // Empty at first render: a pre-computed timestamp here differs between the
  // server prerender and the client hydration pass and trips React's
  // hydration check (console errors on every load). Boot logs go in an effect.
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [checkingAddr, setCheckingAddr] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [txByAccount, setTxByAccount] = useState<Record<string, string>>({});

  const writeClientRef = useRef<GenClient | null>(null);
  const logIdRef = useRef(1);
  const termRef = useRef<HTMLDivElement | null>(null);

  const pushLog = useCallback((level: LogLevel, msg: string, txHash?: string) => {
    setLogs((prev) => [
      ...prev.slice(-200),
      { id: logIdRef.current++, time: new Date().toLocaleTimeString('en-GB'), level, msg, txHash },
    ]);
  }, []);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // Client-only boot logs (never rendered on the server).
  useEffect(() => {
    pushLog('info', 'CollateralGuard risk engine online — GenLayer Intelligent Consensus ready');
    pushLog('info', `Target contract: ${short(CONTRACT_ADDRESS)} on ${NETWORK_LABEL} (61999)`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── GenVM reads/writes through the official SDK ── */

  const callView = useCallback(
    async (method: string, args: unknown[] = []): Promise<unknown> => {
      // SDK handles GenVM calldata encoding + decoding; a str return arrives as a JS string.
      return await getReadClient().readContract({
        address: CONTRACT_ADDRESS,
        functionName: method,
        args: args as any,
      });
    },
    [],
  );

  const sendWrite = useCallback(
    async (method: string, args: unknown[]): Promise<string> => {
      const client = writeClientRef.current;
      if (!client) throw new Error('wallet not connected');
      const txHash = await client.writeContract({
        address: CONTRACT_ADDRESS,
        functionName: method,
        args: args as any,
        value: BigInt(0),
      });
      pushLog('info', `Tx broadcast: ${short(txHash)} — waiting for GenVM consensus…`, txHash);

      // ACCEPTED = validators agreed on the execution; AI consensus can take
      // a while, so wait patiently (≈3 min) before falling back to polling.
      let receipt: any = null;
      try {
        receipt = await getReadClient().waitForTransactionReceipt({
          hash: txHash,
          status: TransactionStatus.ACCEPTED,
          interval: 2000,
          retries: 90,
        });
      } catch (e: any) {
        pushLog('warn', `Still waiting for consensus (${e?.message ?? 'receipt timeout'}) — watching contract state instead`);
      }
      if (receipt && receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
        const detail =
          receipt.stderr ||
          receipt.errorMessage ||
          receipt.error_message ||
          receipt.resultName ||
          'unknown revert';
        pushLog('error', `Contract execution reverted on-chain: ${detail}`, txHash);
        throw new Error(`execution reverted: ${detail}`);
      }
      if (receipt && receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN) {
        pushLog('success', 'Consensus ACCEPTED — validators finalized the execution', txHash);
      }
      return txHash;
    },
    [pushLog],
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
        if (i % 3 === 2) pushLog('ai', `Validators deliberating… (${i + 1}/${attempts})`);
      }
      return null;
    },
    [callView, pushLog],
  );

  const syncFromChain = useCallback(async () => {
    try {
      const raw = await callView('get_all_accounts', []);
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(list) && list.length > 0) {
        setPositions(list.map((r: any) => ({ ...r, address: r.address, localOnly: false }) as Position));
        pushLog('success', `Synced ${list.length} monitored account(s) from GenVM state`);
      }
      const ps = await callView('get_protocol_state', []);
      const st = typeof ps === 'string' ? JSON.parse(ps) : ps;
      if (st && typeof st === 'object') setPaused(Boolean((st as any).paused));
    } catch {
      /* silent — the demo continues on local state */
    }
  }, [callView, pushLog]);

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
        // Write client signs through MetaMask; connect() switches the wallet to
        // Studionet (chain 61999) and adds the network if it is not present.
        const client = createClient({
          chain: studionet,
          account: addr as `0x${string}`,
          provider: eth,
        });
        await client.connect('studionet');
        writeClientRef.current = client;
        setWallet(addr);
        pushLog('success', `Wallet connected: ${short(addr)} — ${NETWORK_LABEL} (61999)`);
        void syncFromChain();
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
      pushLog('ai', `check_and_protect(${short(pos.address)}) → validators fetching ${pos.collateral_asset} price via Binance, then LLM consensus…`);
      try {
        const hash = await sendWrite('check_and_protect', [pos.address]);
        pushLog('ai', 'Equivalence principle active — every validator must agree on the risk verdict…');
        const fresh = await pollPosition(pos.address);
        if (fresh) {
          upsert(fresh);
          setTxByAccount((prev) => ({ ...prev, [pos.address]: hash }));
          const level: LogLevel = fresh.status === 'CRITICAL' ? 'error' : fresh.status === 'WARNING' ? 'warn' : 'success';
          pushLog(level, fresh.last_message, hash);
          if (fresh.status === 'CRITICAL') {
            setPaused(true);
            pushLog('error', 'CIRCUIT BREAKER ENGAGED — every further check() will revert until the owner resumes the protocol');
          }
        } else {
          pushLog('warn', 'Consensus still in flight — press Refresh in a moment to pick up the verdict');
        }
      } catch (e: any) {
        pushLog('error', `check_and_protect failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setCheckingAddr(null);
      }
    },
    [wallet, connectWallet, pushLog, sendWrite, pollPosition, upsert],
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
        pushLog('info', `add_monitored_account(${short(account)}, ${collateral} ${form.asset}, ${debt} USDT) — confirm in MetaMask…`);
        const hash = await sendWrite('add_monitored_account', [account, collateral, debt, form.asset, 'USDT']);
        // Optimistic local update so the funds appear in the table immediately,
        // then confirm against real GenVM state in the background.
        upsert({
          address: account,
          collateral_amount: collateral,
          debt_amount: debt,
          collateral_asset: form.asset,
          debt_asset: 'USDT',
          status: 'SAFE',
          last_ratio: 0,
          ai_sentiment: 'N/A',
          last_message: 'Broadcast — awaiting first AI consensus check',
          last_checked: 'PENDING',
        });
        setTxByAccount((prev) => ({ ...prev, [account]: hash }));
        setModalOpen(false);
        pushLog('success', `FUNDS_ADDED: ${short(account)} is now monitored — ${fmtUSD(collateral * (DISPLAY_PRICES[form.asset] ?? 1000))} collateral vs ${fmtUSD(debt)} debt`, hash);
        void pollPosition(account, 8, 4000).then((fresh) => {
          if (fresh) {
            upsert(fresh);
            pushLog('info', `On-chain state confirmed for ${short(account)}`, hash);
          }
        });
      } catch (e: any) {
        pushLog('error', `add_monitored_account failed: ${e?.shortMessage ?? e?.message ?? e}`);
      } finally {
        setAdding(false);
      }
    },
    [wallet, connectWallet, pushLog, sendWrite, upsert, pollPosition],
  );

  const resumeProtocol = useCallback(async () => {
    setResuming(true);
    pushLog('info', 'resume_protocol() — only the deployer can disengage the circuit breaker…');
    try {
      const hash = await sendWrite('resume_protocol', []);
      for (let i = 0; i < 6; i++) {
        await sleep(4000);
        try {
          const ps = await callView('get_protocol_state', []);
          const st = typeof ps === 'string' ? JSON.parse(ps) : ps;
          if (st && typeof st === 'object' && !(st as any).paused) {
            setPaused(false);
            pushLog('success', 'PROTOCOL_RESUMED: circuit breaker disengaged — checks are live again', hash);
            return;
          }
        } catch { /* settling */ }
      }
      pushLog('warn', 'Resume still settling in consensus — check again shortly');
    } catch (e: any) {
      pushLog('error', `resume_protocol failed: ${e?.shortMessage ?? e?.message ?? e}`);
    } finally {
      setResuming(false);
    }
  }, [pushLog, sendWrite, callView]);

  /* ── derived dashboard data ── */

  const stats = useMemo(() => {
    const coll = positions.reduce((s, p) => s + p.collateral_amount * (DISPLAY_PRICES[p.collateral_asset] ?? 1000), 0);
    const debt = positions.reduce((s, p) => s + p.debt_amount, 0);
    const health = debt > 0 ? Math.round((coll * 100) / debt) : 0;
    return { coll, debt, health };
  }, [positions]);

  const allocation = useMemo(() => {
    const byAsset: Record<string, number> = {};
    for (const p of positions) {
      byAsset[p.collateral_asset] = (byAsset[p.collateral_asset] ?? 0) + p.collateral_amount * (DISPLAY_PRICES[p.collateral_asset] ?? 1000);
    }
    return Object.entries(byAsset).map(([asset, value]) => ({
      label: asset,
      value,
      color: ASSET_COLORS[asset] ?? '#64748b',
    }));
  }, [positions]);

  const healthColor = stats.health >= THRESHOLD ? 'text-emerald-400' : 'text-rose-400';

  return (
    <div className="flex min-h-screen bg-[#070b14] text-slate-200">
      <Sidebar wallet={wallet} />

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
            <span className="hidden rounded-full border border-[#1b2b47] bg-[#0d1526] px-3 py-1.5 text-[11px] text-slate-400 sm:inline">
              LIQ threshold <span className="font-semibold text-slate-200">{THRESHOLD}%</span>
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
          {paused && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <div className="flex items-center gap-3 text-sm text-rose-300">
                <span className="h-2 w-2 animate-ping rounded-full bg-rose-400" />
                <span className="font-semibold">Circuit breaker active</span>
                <span className="text-rose-300/70">— collateral ratio breached {THRESHOLD}%; all checks revert until resumed.</span>
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

          {/* stats */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[
              { label: 'Total Collateral', value: fmtUSD(stats.coll), sub: 'across monitored accounts', accent: 'text-cyan-300' },
              { label: 'Total Debt', value: fmtUSD(stats.debt), sub: 'USDT denominated', accent: 'text-rose-300' },
              { label: 'Portfolio Health', value: `${stats.health}%`, sub: `threshold ${THRESHOLD}%`, accent: healthColor },
              { label: 'Monitored Accounts', value: String(positions.length), sub: paused ? 'protocol paused' : 'protocol operational', accent: 'text-slate-100' },
            ].map((c) => (
              <div key={c.label} className="rounded-2xl border border-[#131c30] bg-[#0b1120] p-4">
                <div className="text-[11px] uppercase tracking-widest text-slate-500">{c.label}</div>
                <div className={`mt-1.5 text-2xl font-semibold ${c.accent}`}>{c.value}</div>
                <div className="mt-1 text-[11px] text-slate-600">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* charts */}
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
                <HealthTimeline positions={positions} threshold={THRESHOLD} />
              </div>
            </div>
          </div>

          {/* table + terminal */}
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <div className="overflow-hidden rounded-2xl border border-[#131c30] bg-[#0b1120]">
                <div className="flex items-center justify-between border-b border-[#131c30] px-5 py-3.5">
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
                              {p.localOnly ? 'local preview' : 'on-chain'}
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
                              {fmtUSD(p.collateral_amount * (DISPLAY_PRICES[p.collateral_asset] ?? 1000))}
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
                              onClick={() => void runCheck(p)}
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
            </div>

            <Terminal logs={logs} termRef={termRef} />
          </div>
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
