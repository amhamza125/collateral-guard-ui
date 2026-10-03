"use client";

import React, { useState } from "react";

const CONTRACT_ADDRESS = "0xD914f1eC67f29B0eA078A0A8d32b3c0461504754";
const SCALE = 10n ** 18n;

interface Position {
  address: string;
  collateralAmount: number;
  debtAmount: number;
  collateralAsset: string;
  debtAsset: string;
  thresholdPercent: number;
  currentRatio: number;
  status: "SAFE" | "WARNING" | "CRITICAL";
}

export default function CollateralGuardDashboard() {
  const [protocolPaused, setProtocolPaused] = useState<boolean>(false);
  const [globalThreshold] = useState<number>(150);
  const [aiSentiment, setAiSentiment] = useState<"NEUTRAL" | "CATASTROPHIC">("NEUTRAL");
  const [activeTab, setActiveTab] = useState<string>("Dashboard");
  const [statusLog, setStatusLog] = useState<{ msg: string; type: "info" | "warn" | "danger" | "success"; time: string }[]>([
    { msg: "Connected to GenLayer Testnet. Ready.", type: "info", time: "Just now" },
  ]);

  const [positions, setPositions] = useState<Position[]>([
    {
      address: "0x4edD...873a",
      collateralAmount: 12.5,
      debtAmount: 18500,
      collateralAsset: "WETH",
      debtAsset: "USDC",
      thresholdPercent: 150,
      currentRatio: 215.4,
      status: "SAFE",
    },
    {
      address: "0x7a25...93b1",
      collateralAmount: 4.2,
      debtAmount: 9800,
      collateralAsset: "WETH",
      debtAsset: "USDC",
      thresholdPercent: 150,
      currentRatio: 137.2,
      status: "CRITICAL",
    },
    {
      address: "0x9c3f...aa14",
      collateralAmount: 28.0,
      debtAmount: 48000,
      collateralAsset: "WETH",
      debtAsset: "USDT",
      thresholdPercent: 140,
      currentRatio: 158.0,
      status: "WARNING",
    },
  ]);

  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [showCheckModal, setShowCheckModal] = useState<boolean>(false);
  const [modalAddress, setModalAddress] = useState<string>("");
  const [modalCollateral, setModalCollateral] = useState<string>("");
  const [modalDebt, setModalDebt] = useState<string>("");

  const addLog = (msg: string, type: "info" | "warn" | "danger" | "success" = "info") => {
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setStatusLog((prev) => [{ msg, type, time: timeStr }, ...prev.slice(0, 9)]);
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalAddress || !modalCollateral || !modalDebt) return;

    const coll = parseFloat(modalCollateral);
    const dbt = parseFloat(modalDebt);
    const mockPriceWeth = 3200; 
    const ratio = ((coll * mockPriceWeth) / dbt) * 100;
    const status: "SAFE" | "WARNING" | "CRITICAL" = ratio < globalThreshold ? "CRITICAL" : ratio < globalThreshold + 15 ? "WARNING" : "SAFE";

    const newPos: Position = {
      address: modalAddress.slice(0, 6) + "..." + modalAddress.slice(-4),
      collateralAmount: coll,
      debtAmount: dbt,
      collateralAsset: "WETH",
      debtAsset: "USDC",
      thresholdPercent: globalThreshold,
      currentRatio: parseFloat(ratio.toFixed(1)),
      status,
    };

    setPositions([newPos, ...positions]);
    addLog(`add_monitored_account(${newPos.address}) recorded to Merkle state.`, "success");
    setShowAddModal(false);
    setModalAddress("");
    setModalCollateral("");
    setModalDebt("");
  };

  const handleCheckAndProtect = (targetAddr: string) => {
    addLog(`Invoking check_and_protect(${targetAddr})... Strict oracle pull triggered.`, "info");
    
    const target = positions.find((p) => p.address === targetAddr);
    if (!target) {
      addLog(`Account ${targetAddr} not found in monitored state.`, "danger");
      return;
    }

    if (protocolPaused) {
      addLog("PROTOCOL_ALREADY_PAUSED: Protective pause active.", "warn");
      return;
    }

    setTimeout(() => {
      if (target.status === "CRITICAL") {
        setProtocolPaused(true);
        addLog(`CRITICAL BREACH: Ratio ${target.currentRatio}% < ${target.thresholdPercent}%. Protocol PAUSED.`, "danger");
      } else if (target.status === "WARNING" || aiSentiment === "CATASTROPHIC") {
        addLog(`RATIO_WARNING_CONDITION: Position near threshold or negative sentiment active.`, "warn");
      } else {
        addLog(`RATIO_SAFE_CONDITION_HELD: Ratio ${target.currentRatio}% >= Threshold. Sentinel halted.`, "success");
      }
    }, 700);
  };

  const handleUnpause = () => {
    setProtocolPaused(false);
    addLog("unpause_protocol() executed by owner. Circuit breaker reset.", "success");
  };

  const handleRemove = (addr: string) => {
    setPositions(positions.filter((p) => p.address !== addr));
    addLog(`remove_monitored_account(${addr}) executed.`, "info");
  };

  return (
    <div className="flex h-screen bg-[#070b14] text-slate-100 font-sans overflow-hidden">
      <aside className="w-64 bg-[#0d1322] border-r border-slate-800/60 flex flex-col justify-between shrink-0">
        <div>
          <div className="p-6 flex items-center space-x-3 border-b border-slate-800/40">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold tracking-wider text-white">GENLAYER</h1>
              <p className="text-[10px] tracking-widest text-blue-400 font-mono">SENTINEL GUARD</p>
            </div>
          </div>

          <nav className="p-4 space-y-1">
            {[
              { id: "Dashboard", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
              { id: "Monitors", label: "Monitors", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
              { id: "Sentinel", label: "Sentinel Rules", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
              { id: "AI News", label: "AI Oracle Feed", icon: "M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" },
              { id: "Logs", label: "Receipt Logs", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  activeTab === item.id
                    ? "bg-blue-600/15 text-blue-400 border border-blue-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} />
                </svg>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 m-4 rounded-xl bg-gradient-to-br from-blue-950/40 to-slate-900 border border-blue-800/30">
          <div className="flex items-center space-x-2 text-xs text-blue-400 font-semibold mb-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>TESTNET RPC LIVE</span>
          </div>
          <p className="text-[11px] text-slate-400 font-mono truncate">{CONTRACT_ADDRESS}</p>
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-y-auto">
        <header className="h-16 border-b border-slate-800/60 px-8 flex items-center justify-between bg-[#0b101b]/80 backdrop-blur shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">CollateralGuard Sentinel</h2>
            <p className="text-xs text-slate-400">GenVM Contract-Pull DeFi Risk Engine</p>
          </div>

          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-lg text-xs font-mono">
              <span className="text-slate-400">Price Window:</span>
              <span className="text-blue-400 font-semibold">300s (5m)</span>
            </div>
            <div className="flex items-center space-x-2 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-lg text-xs font-mono">
              <span className="text-slate-400">AI Cache:</span>
              <span className="text-indigo-400 font-semibold">3600s (1h)</span>
            </div>
            <div className={`px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center space-x-1.5 ${
              protocolPaused
                ? "bg-red-500/10 text-red-400 border-red-500/30"
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            }`}>
              <span className={`w-2 h-2 rounded-full ${protocolPaused ? "bg-red-400" : "bg-emerald-400"}`}></span>
              <span>{protocolPaused ? "PAUSED (CIRCUIT TRIPPED)" : "ACTIVE GUARD"}</span>
            </div>
          </div>
        </header>

        <div className="p-8 space-y-6 max-w-7xl">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl relative overflow-hidden">
              <p className="text-xs font-medium text-slate-400">Total Monitored Value</p>
              <h3 className="text-2xl font-bold text-white mt-1">$142,880.00</h3>
              <div className="mt-3 flex items-center text-xs text-emerald-400 font-medium">
                <span>+4.2% healthy buffer</span>
              </div>
            </div>

            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl relative overflow-hidden">
              <p className="text-xs font-medium text-slate-400">Liquidation Threshold</p>
              <h3 className="text-2xl font-bold text-white mt-1">{globalThreshold}%</h3>
              <div className="mt-3 flex items-center text-xs text-slate-400 font-mono">
                <span>Scaled: 1.5 × 10¹⁸</span>
              </div>
            </div>

            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl relative overflow-hidden">
              <p className="text-xs font-medium text-slate-400">Active Positions</p>
              <h3 className="text-2xl font-bold text-white mt-1">{positions.length} Total</h3>
              <div className="mt-3 flex items-center space-x-2 text-xs">
                <span className="text-emerald-400">{positions.filter(p => p.status === "SAFE").length} Safe</span>
                <span className="text-amber-400">{positions.filter(p => p.status === "WARNING").length} Warn</span>
                <span className="text-red-400">{positions.filter(p => p.status === "CRITICAL").length} Crit</span>
              </div>
            </div>

            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl flex flex-col justify-between">
              <p className="text-xs font-medium text-slate-400 mb-2">Contract Direct Calls</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setShowAddModal(true)}
                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2 px-3 rounded-xl transition-all shadow-sm shadow-blue-500/20"
                >
                  + Add Account
                </button>
                {protocolPaused ? (
                  <button
                    onClick={handleUnpause}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 px-3 rounded-xl transition-all"
                  >
                    Unpause
                  </button>
                ) : (
                  <button
                    onClick={() => setShowCheckModal(true)}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2 px-3 rounded-xl border border-slate-700 transition-all"
                  >
                    Run Check
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-6 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-sm font-semibold text-white">Collateral Ratio Stability</h4>
                  <p className="text-xs text-slate-400">Real-time health index vs 150% threshold</p>
                </div>
                <span className="text-xs bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-lg text-blue-400 font-mono">
                  18-Dec Fixed Int
                </span>
              </div>

              <div className="h-44 w-full flex items-end relative pt-4">
                <svg className="w-full h-full overflow-visible" viewBox="0 0 500 150">
                  <line x1="0" y1="95" x2="500" y2="95" stroke="#ef4444" strokeDasharray="4 4" strokeWidth="1.5" opacity="0.6" />
                  <text x="10" y="90" fill="#ef4444" fontSize="10" fontFamily="monospace">150% Threshold</text>
                  
                  <path
                    d="M 0,40 Q 80,20 150,60 T 300,30 T 420,80 T 500,45"
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth="3"
                  />
                  {[
                    [0, 40], [80, 20], [150, 60], [220, 45], [300, 30], [360, 55], [420, 80], [500, 45]
                  ].map(([cx, cy], i) => (
                    <circle key={i} cx={cx} cy={cy} r="4" fill="#60a5fa" stroke="#0f1627" strokeWidth="2" />
                  ))}
                </svg>
              </div>

              <div className="flex justify-between text-[11px] text-slate-500 font-mono mt-3 pt-3 border-t border-slate-800/50">
                <span>10:00 (W-1)</span>
                <span>10:15 (W-2)</span>
                <span>10:30 (W-3)</span>
                <span>10:45 (W-4)</span>
                <span>11:00 (Current)</span>
              </div>
            </div>

            <div className="lg:col-span-3 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white">Asset Allocation</h4>
                <p className="text-xs text-slate-400">Locked assets in positions</p>
              </div>

              <div className="relative flex items-center justify-center my-2">
                <svg className="w-32 h-32 transform -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-slate-800"
                    strokeWidth="3.8"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className="text-blue-500"
                    strokeDasharray="65, 100"
                    strokeWidth="3.8"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className="text-indigo-400"
                    strokeDasharray="35, 100"
                    strokeDashoffset="-65"
                    strokeWidth="3.8"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <div className="absolute text-center">
                  <span className="text-xs text-slate-400 block">Total</span>
                  <span className="text-sm font-bold text-white font-mono">$142K</span>
                </div>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="flex items-center space-x-1.5 text-slate-300">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                    <span>WETH (Collateral)</span>
                  </span>
                  <span className="font-mono text-slate-400">65%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center space-x-1.5 text-slate-300">
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-400"></span>
                    <span>USDC/USDT (Debt)</span>
                  </span>
                  <span className="font-mono text-slate-400">35%</span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white">AI Market Sentiment</h4>
                <p className="text-xs text-slate-400">gl.nondet.exec_prompt() classification</p>
              </div>

              <div className="flex flex-col items-center justify-center my-2">
                <div className="relative w-36 h-20 overflow-hidden flex items-end justify-center">
                  <div className={
                    "w-36 h-36 rounded-full border-[10px] border-slate-800 " +
                    "border-t-amber-500 border-r-emerald-500 border-l-red-500 " +
                    "absolute top-0 transform -rotate-45"
                  }></div>
                  <div className="text-center z-10 mb-1">
                    <span className={`text-base font-bold font-mono ${aiSentiment === "CATASTROPHIC" ? "text-red-400" : "text-emerald-400"}`}>
                      {aiSentiment}
                    </span>
                  </div>
                </div>
                <div className="flex justify-between w-full text-[10px] text-slate-400 font-mono px-2 mt-1">
                  <span className="text-red-400">CATASTROPHIC</span>
                  <span className="text-emerald-400">NEUTRAL</span>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/60">
                <button
                  onClick={() => {
                    const next = aiSentiment === "NEUTRAL" ? "CATASTROPHIC" : "NEUTRAL";
                    setAiSentiment(next);
                    addLog(`Simulated news oracle trigger: Payload marked ${next}.`, next === "CATASTROPHIC" ? "warn" : "info");
                  }}
                  className="w-full text-xs py-1.5 px-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg text-slate-300 font-mono transition-all"
                >
                  Toggle AI Feed: {aiSentiment}
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-sm font-semibold text-white">Monitored Positions (TreeMap)</h4>
                  <p className="text-xs text-slate-400">Deterministic key-sorted accounts on-chain</p>
                </div>
                <span className="text-xs text-slate-400 font-mono">{positions.length} active entries</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400 border-b border-slate-800 font-mono">
                    <tr>
                      <th className="pb-3">Account</th>
                      <th className="pb-3">Collateral</th>
                      <th className="pb-3">Debt</th>
                      <th className="pb-3">Ratio</th>
                      <th className="pb-3">Risk Status</th>
                      <th className="pb-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {positions.map((pos, idx) => (
                      <tr key={idx} className="hover:bg-slate-900/40 transition-colors">
                        <td className="py-3.5 font-semibold text-slate-200">{pos.address}</td>
                        <td className="py-3.5 text-slate-300">{pos.collateralAmount} {pos.collateralAsset}</td>
                        <td className="py-3.5 text-slate-300">${pos.debtAmount.toLocaleString()}</td>
                        <td className="py-3.5 font-bold">
                          <span className={pos.status === "CRITICAL" ? "text-red-400" : pos.status === "WARNING" ? "text-amber-400" : "text-emerald-400"}>
                            {pos.currentRatio}%
                          </span>
                        </td>
                        <td className="py-3.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            pos.status === "CRITICAL"
                              ? "bg-red-500/20 text-red-400 border border-red-500/40"
                              : pos.status === "WARNING"
                              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                              : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                          }`}>
                            {pos.status}
                          </span>
                        </td>
                        <td className="py-3.5 text-right space-x-2">
                          <button
                            onClick={() => handleCheckAndProtect(pos.address)}
                            className="bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white px-2.5 py-1 rounded-lg text-[11px] font-sans transition-all border border-blue-500/30"
                          >
                            Check
                          </button>
                          <button
                            onClick={() => handleRemove(pos.address)}
                            className="bg-red-500/10 hover:bg-red-600 text-red-400 hover:text-white px-2.5 py-1 rounded-lg text-[11px] font-sans transition-all border border-red-500/20"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-4 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white mb-1">Sentinel Receipt Logs</h4>
                <p className="text-xs text-slate-400 mb-4">Event emissions & exception receipts</p>
                <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1 font-mono text-[11px]">
                  {statusLog.map((log, i) => (
                    <div
                      key={i}
                      className={`p-2.5 rounded-xl border ${
                        log.type === "danger"
                          ? "bg-red-950/20 border-red-800/40 text-red-300"
                          : log.type === "warn"
                          ? "bg-amber-950/20 border-amber-800/40 text-amber-300"
                          : log.type === "success"
                          ? "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
                          : "bg-slate-900 border-slate-800 text-slate-300"
                      }`}
                    >
                      <div className="flex justify-between text-[9px] text-slate-400 mb-1">
                        <span>Receipt</span>
                        <span>{log.time}</span>
                      </div>
                      <p className="break-all">{log.msg}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-800/60 mt-4">
                <span className="text-[10px] text-slate-500 font-mono">
                  State Merkle Root: Deterministic TreeMap Sync
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {showAddModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#0f1627] border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-base font-bold text-white">add_monitored_account</h3>
            <p className="text-xs text-slate-400">Registers a position into the Merkleized TreeMap state.</p>
            <form onSubmit={handleAddAccount} className="space-y-3">
              <div>
                <label className="text-[11px] font-mono text-slate-400">Account Address (0x...)</label>
                <input
                  type="text"
                  required
                  placeholder="0x4edD19dcEa0A493E6fa5Fe2DDCF83b0778f0873a"
                  value={modalAddress}
                  onChange={(e) => setModalAddress(e.target.value)}
                  className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white outline-none focus:border-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-mono text-slate-400">Collateral (WETH)</label>
                  <input
                    type="number"
                    step="any"
                    required
                    placeholder="10"
                    value={modalCollateral}
                    onChange={(e) => setModalCollateral(e.target.value)}
                    className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-mono text-slate-400">Debt (USDC)</label>
                  <input
                    type="number"
                    step="any"
                    required
                    placeholder="5000"
                    value={modalDebt}
                    onChange={(e) => setModalDebt(e.target.value)}
                    className="w-full mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-semibold rounded-xl text-white"
                >
                  Commit Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCheckModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#0f1627] border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-base font-bold text-white">Execute check_and_protect</h3>
            <p className="text-xs text-slate-400">Simulate a keeper triggering the dual-consensus check.</p>
            <div className="space-y-2">
              <label className="text-[11px] font-mono text-slate-400">Select Target Position</label>
              {positions.map((pos, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    handleCheckAndProtect(pos.address);
                    setShowCheckModal(false);
                  }}
                  className="w-full p-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 flex justify-between items-center text-xs font-mono transition-colors"
                >
                  <span className="text-slate-200">{pos.address}</span>
                  <span className={pos.status === "CRITICAL" ? "text-red-400" : pos.status === "WARNING" ? "text-amber-400" : "text-emerald-400"}>
                    {pos.currentRatio}%
                  </span>
                </button>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowCheckModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
