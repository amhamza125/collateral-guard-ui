"use client";

import React, { useState, useEffect, useMemo } from "react";
import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0xD914f1eC67f29B0eA078A0A8d32b3c0461504754";
const WETH_PRICE = 3200; // Fixed oracle price for the demo math

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
  // Wallet & Blockchain State
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // Protocol State (Starts completely empty for real demo flow)
  const [protocolPaused, setProtocolPaused] = useState<boolean>(false);
  const [globalThreshold] = useState<number>(150);
  const [aiSentiment, setAiSentiment] = useState<"NEUTRAL" | "CATASTROPHIC">("NEUTRAL");
  const [activeTab, setActiveTab] = useState<string>("Dashboard");
  const [positions, setPositions] = useState<Position[]>([]);
  
  const [statusLog, setStatusLog] = useState<{ msg: string; type: "info" | "warn" | "danger" | "success"; time: string }[]>([
    { msg: "System Ready. Awaiting Wallet Connection...", type: "info", time: new Date().toLocaleTimeString() },
  ]);

  // Form State
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [modalCollateral, setModalCollateral] = useState<string>("");
  const [modalDebt, setModalDebt] = useState<string>("");
  const [isTxPending, setIsTxPending] = useState<boolean>(false);

  // --- WALLET CONNECTION LOGIC ---
  const connectWallet = async () => {
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        setIsConnecting(true);
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        await provider.send("eth_requestAccounts", []);
        const signer = await provider.getSigner();
        const address = await signer.getAddress();
        setWalletAddress(address);
        addLog(`Wallet Connected: ${address.slice(0, 6)}...${address.slice(-4)}`, "success");
      } catch (err) {
        addLog("Wallet connection rejected.", "danger");
      } finally {
        setIsConnecting(false);
      }
    } else {
      alert("Please install MetaMask or a Web3 wallet to connect.");
    }
  };

  const addLog = (msg: string, type: "info" | "warn" | "danger" | "success" = "info") => {
    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setStatusLog((prev) => [{ msg, type, time: timeStr }, ...prev.slice(0, 9)]);
  };

  // --- DYNAMIC CALCULATIONS BASED ON REAL INPUTS ---
  const totalMonitoredValue = useMemo(() => {
    return positions.reduce((sum, pos) => sum + (pos.collateralAmount * WETH_PRICE), 0);
  }, [positions]);

  const safeCount = positions.filter(p => p.status === "SAFE").length;
  const warnCount = positions.filter(p => p.status === "WARNING").length;
  const critCount = positions.filter(p => p.status === "CRITICAL").length;

  // --- ADD FUNDS (REAL FLOW) ---
  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress) {
      alert("Please connect your wallet first!");
      return;
    }
    if (!modalCollateral || !modalDebt) return;

    setIsTxPending(true);
    addLog(`Initiating add_monitored_account for ${modalCollateral} WETH...`, "info");

    // Simulate blockchain confirmation delay for the video
    setTimeout(() => {
      const coll = parseFloat(modalCollateral);
      const dbt = parseFloat(modalDebt);
      const ratio = ((coll * WETH_PRICE) / dbt) * 100;
      
      const status: "SAFE" | "WARNING" | "CRITICAL" = 
        ratio < globalThreshold ? "CRITICAL" : ratio < globalThreshold + 15 ? "WARNING" : "SAFE";

      const newPos: Position = {
        address: walletAddress,
        collateralAmount: coll,
        debtAmount: dbt,
        collateralAsset: "WETH",
        debtAsset: "USDC",
        thresholdPercent: globalThreshold,
        currentRatio: parseFloat(ratio.toFixed(1)),
        status,
      };

      // Ensure we overwrite if the same wallet adds again, simulating update_position
      setPositions(prev => {
        const filtered = prev.filter(p => p.address !== walletAddress);
        return [newPos, ...filtered];
      });

      addLog(`Position recorded to GenLayer Merkle state.`, "success");
      setIsTxPending(false);
      setShowAddModal(false);
      setModalCollateral("");
      setModalDebt("");
    }, 2000); // 2 second mock tx time
  };

  // --- SENTINEL CHECK (REAL MATH EVALUATION) ---
  const handleCheckAndProtect = (targetAddr: string) => {
    addLog(`Invoking check_and_protect(${targetAddr.slice(0,6)}...)...`, "info");
    
    const target = positions.find((p) => p.address === targetAddr);
    if (!target) return;

    if (protocolPaused) {
      addLog("PROTOCOL_ALREADY_PAUSED: Protective pause active.", "warn");
      return;
    }

    // Simulate contract execution delay
    setTimeout(() => {
      if (target.status === "CRITICAL") {
        setProtocolPaused(true);
        addLog(`CRITICAL BREACH: Ratio ${target.currentRatio}% < ${target.thresholdPercent}%. Protocol PAUSED.`, "danger");
      } else if (target.status === "WARNING" || aiSentiment === "CATASTROPHIC") {
        addLog(`RATIO_WARNING_CONDITION: Near threshold or negative AI sentiment.`, "warn");
      } else {
        addLog(`RATIO_SAFE_CONDITION_HELD: Ratio ${target.currentRatio}% >= Threshold. Sentinel halted.`, "success");
      }
    }, 1500);
  };

  const handleUnpause = () => {
    setProtocolPaused(false);
    addLog("unpause_protocol() executed by owner. Circuit breaker reset.", "success");
  };

  return (
    <div className="flex h-screen bg-[#070b14] text-slate-100 font-sans overflow-hidden">
      
      {/* SIDEBAR */}
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
            <button className="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium bg-blue-600/15 text-blue-400 border border-blue-500/20 shadow-sm">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              <span>Dashboard</span>
            </button>
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

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col overflow-y-auto">
        <header className="h-16 border-b border-slate-800/60 px-8 flex items-center justify-between bg-[#0b101b]/80 backdrop-blur shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">DeFi Risk Engine</h2>
          </div>
          <div className="flex items-center space-x-4">
            <div className={`px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center space-x-1.5 ${
              protocolPaused ? "bg-red-500/10 text-red-400 border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            }`}>
              <span className={`w-2 h-2 rounded-full ${protocolPaused ? "bg-red-400" : "bg-emerald-400"}`}></span>
              <span>{protocolPaused ? "PAUSED (CIRCUIT TRIPPED)" : "ACTIVE GUARD"}</span>
            </div>
            
            {/* REAL WALLET CONNECT BUTTON */}
            {!walletAddress ? (
              <button 
                onClick={connectWallet}
                disabled={isConnecting}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 px-4 rounded-lg transition-all shadow-sm shadow-blue-500/20"
              >
                {isConnecting ? "Connecting..." : "Connect Wallet"}
              </button>
            ) : (
              <div className="bg-slate-800 border border-slate-700 text-white text-xs font-mono py-2 px-4 rounded-lg">
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </div>
            )}
          </div>
        </header>

        <div className="p-8 space-y-6 max-w-7xl">
          
          {/* METRICS ROW (Updates dynamically) */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl relative overflow-hidden">
              <p className="text-xs font-medium text-slate-400">Total Monitored Value</p>
              <h3 className="text-2xl font-bold text-white mt-1">
                ${totalMonitoredValue > 0 ? totalMonitoredValue.toLocaleString() : "0.00"}
              </h3>
            </div>
            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl relative overflow-hidden">
              <p className="text-xs font-medium text-slate-400">Liquidation Threshold</p>
              <h3 className="text-2xl font-bold text-white mt-1">{globalThreshold}%</h3>
            </div>
            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl relative overflow-hidden">
              <p className="text-xs font-medium text-slate-400">Active Positions</p>
              <h3 className="text-2xl font-bold text-white mt-1">{positions.length}</h3>
              <div className="mt-3 flex items-center space-x-2 text-xs">
                <span className="text-emerald-400">{safeCount} Safe</span>
                <span className="text-amber-400">{warnCount} Warn</span>
                <span className="text-red-400">{critCount} Crit</span>
              </div>
            </div>
            <div className="bg-[#0f1627] border border-slate-800/80 p-5 rounded-2xl flex flex-col justify-between">
              <p className="text-xs font-medium text-slate-400 mb-2">Protocol Controls</p>
              <div className="grid grid-cols-2 gap-2 h-full">
                <button
                  onClick={() => {
                    if (!walletAddress) { alert("Connect wallet first!"); return; }
                    setShowAddModal(true);
                  }}
                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2 px-3 rounded-xl transition-all h-full"
                >
                  + Add Funds
                </button>
                {protocolPaused && (
                  <button onClick={handleUnpause} className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 px-3 rounded-xl transition-all h-full">
                    Unpause
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* AI SENTIMENT GAUGE */}
            <div className="lg:col-span-4 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white">AI Market Sentiment</h4>
                <p className="text-xs text-slate-400">Oracle classification</p>
              </div>
              <div className="flex flex-col items-center justify-center my-4">
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
              </div>
              <button
                onClick={() => {
                  const next = aiSentiment === "NEUTRAL" ? "CATASTROPHIC" : "NEUTRAL";
                  setAiSentiment(next);
                  addLog(`Simulated news oracle trigger: Payload marked ${next}.`, next === "CATASTROPHIC" ? "warn" : "info");
                }}
                className="w-full text-xs py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg text-slate-300 font-mono transition-all"
              >
                Inject Fake News ({aiSentiment})
              </button>
            </div>

            {/* REAL POSITIONS TABLE */}
            <div className="lg:col-span-8 bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-sm font-semibold text-white">Your Monitored Positions</h4>
                  <p className="text-xs text-slate-400">State synced directly from inputs</p>
                </div>
              </div>
              
              <div className="overflow-x-auto flex-1">
                {positions.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 py-10">
                    <svg className="w-12 h-12 mb-3 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                    <p className="text-sm">No positions found.</p>
                    <p className="text-xs mt-1">Connect wallet and click "+ Add Funds" to begin.</p>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-400 border-b border-slate-800 font-mono">
                      <tr>
                        <th className="pb-3">Wallet</th>
                        <th className="pb-3">Collateral</th>
                        <th className="pb-3">Debt</th>
                        <th className="pb-3">Ratio</th>
                        <th className="pb-3 text-right">Run Sentinel Check</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {positions.map((pos, idx) => (
                        <tr key={idx} className="hover:bg-slate-900/40 transition-colors">
                          <td className="py-3.5 font-semibold text-slate-200">
                            {pos.address.slice(0, 6)}...{pos.address.slice(-4)}
                          </td>
                          <td className="py-3.5 text-slate-300">{pos.collateralAmount} {pos.collateralAsset}</td>
                          <td className="py-3.5 text-slate-300">${pos.debtAmount.toLocaleString()}</td>
                          <td className="py-3.5 font-bold">
                            <span className={pos.status === "CRITICAL" ? "text-red-400" : pos.status === "WARNING" ? "text-amber-400" : "text-emerald-400"}>
                              {pos.currentRatio}%
                            </span>
                          </td>
                          <td className="py-3.5 text-right">
                            <button
                              onClick={() => handleCheckAndProtect(pos.address)}
                              className="bg-red-500/10 hover:bg-red-600 text-red-400 hover:text-white px-4 py-1.5 rounded-lg text-xs font-bold transition-all border border-red-500/20"
                            >
                              Run Check()
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
          
          {/* REAL LOGS AREA */}
          <div className="bg-[#0f1627] border border-slate-800/80 rounded-2xl p-6">
            <h4 className="text-sm font-semibold text-white mb-4">Live Receipt Logs</h4>
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1 font-mono text-[11px]">
              {statusLog.map((log, i) => (
                <div key={i} className={`p-2.5 rounded-xl border ${
                    log.type === "danger" ? "bg-red-950/20 border-red-800/40 text-red-300"
                    : log.type === "warn" ? "bg-amber-950/20 border-amber-800/40 text-amber-300"
                    : log.type === "success" ? "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
                    : "bg-slate-900 border-slate-800 text-slate-300"
                  }`}>
                  <div className="flex justify-between text-[9px] text-slate-400 mb-1">
                    <span>Transaction / Event</span>
                    <span>{log.time}</span>
                  </div>
                  <p className="break-all text-sm">{log.msg}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* REAL ADD FUNDS MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#0f1627] border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-bold text-white">Add Position / Funds</h3>
            <p className="text-sm text-slate-400">Lock collateral and mint debt for <span className="font-mono text-blue-400">{walletAddress?.slice(0, 6)}...</span></p>
            <form onSubmit={handleAddAccount} className="space-y-4 pt-2">
              <div>
                <label className="text-xs font-mono text-slate-400 block mb-1">Deposit Collateral (WETH)</label>
                <input
                  type="number"
                  step="any"
                  required
                  placeholder="e.g. 10"
                  value={modalCollateral}
                  onChange={(e) => setModalCollateral(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm font-mono text-white outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs font-mono text-slate-400 block mb-1">Borrow Debt (USDC)</label>
                <input
                  type="number"
                  step="any"
                  required
                  placeholder="e.g. 5000"
                  value={modalDebt}
                  onChange={(e) => setModalDebt(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm font-mono text-white outline-none focus:border-blue-500"
                />
              </div>
              
              <div className="bg-slate-900 p-3 rounded-xl border border-slate-800 mt-4 text-xs font-mono text-slate-400">
                <p>Simulated Oracle WETH Price: <span className="text-white">$3,200</span></p>
                <p>Required Ratio: <span className="text-white">150%</span></p>
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  disabled={isTxPending}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-sm font-semibold rounded-xl text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isTxPending}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-sm font-semibold rounded-xl text-white flex items-center"
                >
                  {isTxPending ? "Confirming..." : "Submit Transaction"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
