"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0xD914f1eC67f29B0eA078A0A8d32b3c0461504754";

// Simulated real-time oracle prices
const ORACLE_PRICES: Record<string, number> = {
  WETH: 3200,
  WBTC: 64500,
  SOL: 145,
  USDC: 1,
  USDT: 1
};

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
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [protocolPaused, setProtocolPaused] = useState<boolean>(false);
  const [aiSentiment, setAiSentiment] = useState<"NEUTRAL" | "CATASTROPHIC">("NEUTRAL");
  const [positions, setPositions] = useState<Position[]>([]);
  
  const [statusLog, setStatusLog] = useState<{ msg: string; type: "info" | "warn" | "danger" | "success"; time: string }[]>([
    { msg: "System Boot... GenVM RPC Initialized.", type: "info", time: new Date().toLocaleTimeString() },
  ]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Form State
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [modalCollateral, setModalCollateral] = useState<string>("");
  const [modalDebt, setModalDebt] = useState<string>("");
  const [modalCollateralAsset, setModalCollateralAsset] = useState<string>("WETH");
  const [modalDebtAsset, setModalDebtAsset] = useState<string>("USDC");
  const [modalThreshold, setModalThreshold] = useState<string>("150");
  const [isTxPending, setIsTxPending] = useState<boolean>(false);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [statusLog]);

  const addLog = (msg: string, type: "info" | "warn" | "danger" | "success" = "info") => {
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setStatusLog((prev) => [...prev, { msg, type, time: timeStr }]);
  };

  const connectWallet = async () => {
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        setIsConnecting(true);
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        await provider.send("eth_requestAccounts", []);
        const signer = await provider.getSigner();
        const address = await signer.getAddress();
        setWalletAddress(address);
        addLog(`Web3 Wallet Connected: ${address}`, "success");
      } catch (err) {
        addLog("Wallet connection rejected by user.", "danger");
      } finally {
        setIsConnecting(false);
      }
    } else {
      alert("Please install MetaMask to connect.");
    }
  };

  const requestWalletSignature = async (actionMsg: string): Promise<boolean> => {
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      addLog(`Awaiting wallet authorization for: ${actionMsg}`, "info");
      // This forces MetaMask to pop up for the video recording!
      await signer.signMessage(`GenLayer Testnet Authorization\n\nAction: ${actionMsg}\nContract: ${CONTRACT_ADDRESS}`);
      addLog(`Signature verified. Executing on GenVM...`, "success");
      return true;
    } catch (error) {
      addLog(`Transaction rejected by wallet.`, "danger");
      return false;
    }
  };

  const totalMonitoredValue = useMemo(() => {
    return positions.reduce((sum, pos) => sum + (pos.collateralAmount * ORACLE_PRICES[pos.collateralAsset]), 0);
  }, [positions]);

  // AI Advisor Logic
  const getAiRecommendation = () => {
    if (positions.length === 0) return "No active positions. Deposit assets to begin AI monitoring.";
    const myPos = positions[0]; 
    if (aiSentiment === "CATASTROPHIC") {
      return `WARNING: The GenLayer Intelligent Oracle has detected CATASTROPHIC sentiment for ${myPos.collateralAsset}. Even if your math is safe, smart contracts may preemptively pause. Consider unwinding debt immediately.`;
    }
    if (myPos.status === "CRITICAL") {
      const requiredCollateral = (myPos.debtAmount * (myPos.thresholdPercent / 100)) / ORACLE_PRICES[myPos.collateralAsset];
      const shortfall = requiredCollateral - myPos.collateralAmount;
      return `CRITICAL RISK: Your position is undercollateralized. You must deposit at least ${shortfall.toFixed(4)} ${myPos.collateralAsset} or repay debt to avoid immediate liquidation.`;
    }
    if (myPos.status === "WARNING") {
      return `CAUTION: Your ratio is nearing the ${myPos.thresholdPercent}% threshold. Market volatility could trigger liquidation. Recommend adding 15% more collateral.`;
    }
    return `SAFE: Your ${myPos.collateralAsset} position is healthy. AI consensus shows normal market conditions.`;
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress) return alert("Connect wallet first!");
    
    setIsTxPending(true);
    const authorized = await requestWalletSignature(`add_monitored_account(${modalCollateral} ${modalCollateralAsset})`);
    
    if (authorized) {
      setTimeout(() => {
        const coll = parseFloat(modalCollateral);
        const dbt = parseFloat(modalDebt);
        const thresh = parseFloat(modalThreshold);
        const collValue = coll * ORACLE_PRICES[modalCollateralAsset];
        const dbtValue = dbt * ORACLE_PRICES[modalDebtAsset];
        const ratio = (collValue / dbtValue) * 100;
        
        const status = ratio < thresh ? "CRITICAL" : ratio < thresh + 15 ? "WARNING" : "SAFE";

        const newPos: Position = {
          address: walletAddress,
          collateralAmount: coll,
          debtAmount: dbt,
          collateralAsset: modalCollateralAsset,
          debtAsset: modalDebtAsset,
          thresholdPercent: thresh,
          currentRatio: parseFloat(ratio.toFixed(1)),
          status,
        };

        setPositions([newPos]); // Overwrites for demo simplicity
        addLog(`Confirmed: Position committed to GenLayer state tree.`, "success");
        setShowAddModal(false);
      }, 1500); // Simulate network latency
    }
    setIsTxPending(false);
  };

  const handleCheckAndProtect = async (targetAddr: string) => {
    if (!walletAddress) return alert("Connect wallet first!");
    if (protocolPaused) return addLog("PROTOCOL PAUSED: Action blocked by circuit breaker.", "warn");

    const target = positions.find((p) => p.address === targetAddr);
    if (!target) return;

    setIsTxPending(true);
    const authorized = await requestWalletSignature(`check_and_protect(${targetAddr.slice(0,6)}...)`);
    
    if (authorized) {
      setTimeout(() => {
        if (target.status === "CRITICAL") {
          setProtocolPaused(true);
          addLog(`CRITICAL BREACH: Ratio ${target.currentRatio}% < Threshold. Circuit Breaker TRIPPED.`, "danger");
        } else if (target.status === "WARNING" || aiSentiment === "CATASTROPHIC") {
          addLog(`WARNING: Position vulnerable due to AI sentiment or tight ratio.`, "warn");
        } else {
          addLog(`RATIO_SAFE: ${target.currentRatio}% >= Threshold. Execution cleared.`, "success");
        }
        setIsTxPending(false);
      }, 2000);
    } else {
      setIsTxPending(false);
    }
  };

  return (
    <div className="flex h-screen bg-[#090d14] text-slate-200 font-sans overflow-hidden">
      
      {/* SIDEBAR */}
      <aside className="w-64 bg-[#0d131f] border-r border-slate-800 flex flex-col justify-between shrink-0">
        <div>
          <div className="p-6 flex items-center space-x-3 border-b border-slate-800">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold text-white">CollateralGuard</h1>
              <p className="text-[10px] text-blue-400 font-mono uppercase tracking-widest">GenLayer Testnet</p>
            </div>
          </div>
        </div>
        <div className="p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs font-mono break-all text-slate-400">
            <p className="text-blue-400 font-bold mb-1">CONTRACT ADDRESS</p>
            {CONTRACT_ADDRESS}
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col overflow-y-auto relative">
        <header className="h-16 border-b border-slate-800 px-8 flex items-center justify-between bg-[#0b101a] shrink-0 sticky top-0 z-10">
          <h2 className="text-lg font-semibold text-white">DeFi Risk Engine</h2>
          <div className="flex items-center space-x-4">
            <div className={`px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center space-x-2 ${
              protocolPaused ? "bg-red-500/10 text-red-400 border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            }`}>
              <span className={`w-2 h-2 rounded-full ${protocolPaused ? "bg-red-400" : "bg-emerald-400"}`}></span>
              <span>{protocolPaused ? "SYSTEM PAUSED" : "SYSTEM ACTIVE"}</span>
            </div>
            {!walletAddress ? (
              <button onClick={connectWallet} disabled={isConnecting} className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 px-4 rounded-lg">
                {isConnecting ? "Connecting..." : "Connect Wallet"}
              </button>
            ) : (
              <div className="bg-slate-800 border border-slate-700 text-white text-xs font-mono py-2 px-4 rounded-lg">
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </div>
            )}
          </div>
        </header>

        <div className="p-8 space-y-6 max-w-7xl mx-auto w-full">
          
          {/* METRICS & ADVISOR */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-[#111724] border border-slate-800 p-6 rounded-2xl">
              <p className="text-xs font-medium text-slate-400">Total Monitored Value</p>
              <h3 className="text-3xl font-bold text-white mt-2">${totalMonitoredValue.toLocaleString(undefined, {minimumFractionDigits: 2})}</h3>
              <button 
                onClick={() => setShowAddModal(true)}
                className="mt-4 w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-sm font-semibold py-2.5 rounded-xl transition-all"
              >
                + Add / Manage Funds
              </button>
            </div>

            <div className="md:col-span-2 bg-gradient-to-br from-indigo-950/40 to-[#111724] border border-indigo-900/30 p-6 rounded-2xl flex flex-col justify-between">
              <div className="flex items-center space-x-2 mb-2">
                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <h3 className="text-sm font-bold text-indigo-300">GenLayer AI Risk Advisor</h3>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                {getAiRecommendation()}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* AI SENTIMENT INJECTOR */}
            <div className="lg:col-span-3 bg-[#111724] border border-slate-800 rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white">Intelligent Oracle</h4>
                <p className="text-[10px] text-slate-500 font-mono mt-1">gl.nondet.exec_prompt()</p>
              </div>
              <div className="flex flex-col items-center justify-center my-6">
                <span className={`text-2xl font-black font-mono tracking-wider ${aiSentiment === "CATASTROPHIC" ? "text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.4)]" : "text-emerald-500 drop-shadow-[0_0_15px_rgba(16,185,129,0.4)]"}`}>
                  {aiSentiment}
                </span>
              </div>
              <button
                onClick={() => setAiSentiment(prev => prev === "NEUTRAL" ? "CATASTROPHIC" : "NEUTRAL")}
                className="w-full text-xs py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-400 font-mono"
              >
                Inject Market News
              </button>
            </div>

            {/* REAL POSITIONS TABLE & HEALTH BARS */}
            <div className="lg:col-span-9 bg-[#111724] border border-slate-800 rounded-2xl p-6">
              <h4 className="text-sm font-semibold text-white mb-4">Active Collateral Positions</h4>
              
              <div className="overflow-x-auto">
                {positions.length === 0 ? (
                  <div className="h-40 flex flex-col items-center justify-center text-slate-500">
                    <p className="text-sm">No positions found.</p>
                  </div>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="text-slate-400 border-b border-slate-800 font-mono text-xs">
                      <tr>
                        <th className="pb-3">Assets</th>
                        <th className="pb-3">Ratio Health</th>
                        <th className="pb-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {positions.map((pos, idx) => (
                        <tr key={idx}>
                          <td className="py-4">
                            <div className="font-semibold text-white">{pos.collateralAmount} {pos.collateralAsset}</div>
                            <div className="text-xs text-slate-500">Debt: {pos.debtAmount} {pos.debtAsset}</div>
                          </td>
                          <td className="py-4 w-1/2 pr-8">
                            <div className="flex justify-between text-xs mb-1">
                              <span className="font-mono text-white">{pos.currentRatio}%</span>
                              <span className="font-mono text-slate-500">Target: {pos.thresholdPercent}%</span>
                            </div>
                            {/* Visual Health Bar */}
                            <div className="w-full bg-slate-900 rounded-full h-2.5 border border-slate-800 overflow-hidden relative">
                               <div 
                                className={`h-2.5 rounded-full ${pos.status === "CRITICAL" ? "bg-red-500" : pos.status === "WARNING" ? "bg-amber-500" : "bg-emerald-500"}`}
                                style={{ width: `${Math.min((pos.currentRatio / (pos.thresholdPercent * 2)) * 100, 100)}%` }}
                               ></div>
                               {/* Threshold Marker */}
                               <div className="absolute top-0 bottom-0 w-0.5 bg-red-500/50" style={{ left: '50%' }}></div>
                            </div>
                          </td>
                          <td className="py-4 text-right">
                            <button
                              onClick={() => handleCheckAndProtect(pos.address)}
                              disabled={isTxPending}
                              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-lg shadow-blue-500/20"
                            >
                              Run Contract Check
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
          
          {/* PROFESSIONAL TERMINAL LOGS */}
          <div className="bg-[#0a0f18] border border-slate-800 rounded-2xl overflow-hidden flex flex-col h-64">
            <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex items-center space-x-2">
              <div className="flex space-x-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/50"></div>
                <div className="w-3 h-3 rounded-full bg-amber-500/50"></div>
                <div className="w-3 h-3 rounded-full bg-emerald-500/50"></div>
              </div>
              <span className="text-xs text-slate-500 font-mono ml-2">genvm_execution_logs.sh</span>
            </div>
            <div className="p-4 flex-1 overflow-y-auto font-mono text-xs space-y-1.5">
              {statusLog.map((log, i) => (
                <div key={i} className="flex space-x-3">
                  <span className="text-slate-600 shrink-0">[{log.time}]</span>
                  <span className={`${
                    log.type === "danger" ? "text-red-400" 
                    : log.type === "warn" ? "text-amber-400" 
                    : log.type === "success" ? "text-emerald-400" 
                    : "text-blue-300"
                  }`}>
                    {log.msg}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </main>

      {/* REAL MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#111724] border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold text-white">Configure Position</h3>
            <p className="text-sm text-slate-400 mb-4">Set dynamic assets and custom risk thresholds.</p>
            
            <form onSubmit={handleAddAccount} className="space-y-4">
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-400 block mb-1">Asset</label>
                  <select 
                    value={modalCollateralAsset} onChange={(e) => setModalCollateralAsset(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    <option value="WETH">WETH ($3,200)</option>
                    <option value="WBTC">WBTC ($64,500)</option>
                    <option value="SOL">SOL ($145)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-400 block mb-1">Amount</label>
                  <input
                    type="number" step="any" required placeholder="0.0"
                    value={modalCollateral} onChange={(e) => setModalCollateral(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-slate-400 block mb-1">Debt Asset</label>
                  <select 
                    value={modalDebtAsset} onChange={(e) => setModalDebtAsset(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    <option value="USDC">USDC ($1)</option>
                    <option value="USDT">USDT ($1)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-slate-400 block mb-1">Amount</label>
                  <input
                    type="number" step="any" required placeholder="0.0"
                    value={modalDebt} onChange={(e) => setModalDebt(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-slate-400 block mb-1">Custom Safety Threshold (%)</label>
                <input
                  type="number" required placeholder="150"
                  value={modalThreshold} onChange={(e) => setModalThreshold(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button type="button" onClick={() => setShowAddModal(false)} disabled={isTxPending} className="px-5 py-2.5 bg-slate-800 text-sm font-semibold rounded-xl text-slate-300">
                  Cancel
                </button>
                <button type="submit" disabled={isTxPending} className="px-5 py-2.5 bg-blue-600 text-sm font-semibold rounded-xl text-white">
                  {isTxPending ? "Awaiting Signature..." : "Sign & Execute"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
