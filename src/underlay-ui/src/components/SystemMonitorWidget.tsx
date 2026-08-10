import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Card, CardContent, CardHeader, CardTitle } from "@underlay/components/ui/card";
import { Cpu, MemoryStick, Activity, Network, Database } from "lucide-react";
import { cn } from "@underlay/lib/utils";

interface SystemStats {
  cpuUsage: number;
  memUsage: number;
  memTotal: number;
  gpuUsage: number | null;
  gpuMemUsage: number | null;
  gpuMemTotal: number | null;
  netUp: number;
  netDown: number;
}

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function ProgressBar({ value, max = 100, colorClass = "bg-primary", className }: { value: number, max?: number, colorClass?: string, className?: string }) {
  const percentage = (max && max > 0) ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
      <div className={cn("h-1.5 w-full bg-black/10 rounded-full overflow-hidden mt-1", className)}>
          <div className={`h-full ${colorClass} transition-all duration-500 ease-out`} style={{ width: `${percentage}%` }} />
      </div>
  )
}

function getUsageColor(value: number, max: number): string {
    const percentage = max > 0 ? (value / max) * 100 : 0;
    if (percentage < 50) return "bg-green-500";
    if (percentage < 90) return "bg-orange-500";
    return "bg-red-500";
}

export function SystemMonitorWidget() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    const unlisten = listen<SystemStats>("system-stats", (event) => {
      setStats(event.payload);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  if (!stats) {
    return (
        <Card 
            className="w-full h-full backdrop-blur-md border-black/10 flex items-center justify-center select-none pointer-events-none"
            style={{ backgroundColor: "rgba(255, 255, 255, 0.5)" }}
        >
            <span className="text-zinc-500 text-xs">Waiting for stats...</span>
        </Card>
    )
  }

  return (
    <Card 
        className="w-full h-full backdrop-blur-md border-black/10 overflow-hidden flex flex-col shadow-sm select-none text-zinc-800"
        style={{ backgroundColor: "rgba(255, 255, 255, 0.5)" }}
    >
      <CardHeader className="pb-2 p-3 flex-shrink-0 border-b border-black/10">
        <CardTitle className="text-xs font-bold uppercase tracking-wider text-zinc-600 flex items-center gap-2">
            <Activity className="h-3 w-3" />
            System Monitor
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-xs p-3 pt-3 flex-grow overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-zinc-300">
        <div className="grid grid-cols-2 gap-4">
            {/* Left Column: CPU & RAM */}
            <div className="space-y-4">
                {/* CPU */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                        <div className="flex items-center gap-1.5 text-zinc-500">
                            <Cpu className="h-3 w-3" />
                            <span>CPU</span>
                        </div>
                        <span className="font-mono font-medium">{stats.cpuUsage.toFixed(1)}%</span>
                    </div>
                    <ProgressBar value={stats.cpuUsage} colorClass="bg-blue-500" />
                </div>

                {/* RAM */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                        <div className="flex items-center gap-1.5 text-zinc-500">
                            <MemoryStick className="h-3 w-3" />
                            <span>RAM</span>
                        </div>
                    </div>
                    <div className="flex justify-end font-mono text-[10px] leading-none">
                        <span className="font-medium">{formatBytes(stats.memUsage)}</span>
                        <span className="text-zinc-400 mx-0.5">/</span>
                        <span className="text-zinc-400">{formatBytes(stats.memTotal)}</span>
                    </div>
                    <ProgressBar value={stats.memUsage} max={stats.memTotal} colorClass={getUsageColor(stats.memUsage, stats.memTotal)} />
                </div>
            </div>

            {/* Right Column: GPU & VRAM */}
            <div className="space-y-4">
                {/* GPU */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                        <div className="flex items-center gap-1.5 text-zinc-500">
                            <Activity className="h-3 w-3" />
                            <span>GPU</span>
                        </div>
                        <span className="font-mono font-medium">{(stats.gpuUsage || 0).toFixed(1)}%</span>
                    </div>
                    <ProgressBar value={stats.gpuUsage || 0} colorClass="bg-indigo-500" />
                </div>

                {/* VRAM */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                        <div className="flex items-center gap-1.5 text-zinc-500">
                            <Database className="h-3 w-3" />
                            <span>VRAM</span>
                        </div>
                    </div>
                    <div className="flex justify-end font-mono text-[10px] leading-none">
                        <span className="font-medium">{formatBytes(stats.gpuMemUsage || 0)}</span>
                        <span className="text-zinc-400 mx-0.5">/</span>
                        <span className="text-zinc-400">{formatBytes(stats.gpuMemTotal || 0)}</span>
                    </div>
                    <ProgressBar value={stats.gpuMemUsage || 0} max={stats.gpuMemTotal || 0} colorClass={getUsageColor(stats.gpuMemUsage || 0, stats.gpuMemTotal || 0)} />
                </div>
            </div>
        </div>

        {/* Network */}
        <div className="pt-4 mt-2 border-t border-black/10">
            <div className="flex items-center justify-center mb-2">
                <div className="flex items-center gap-1.5 text-zinc-500">
                    <Network className="h-3.5 w-3.5" />
                    <span>Network</span>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-[10px] font-mono text-center">
                <div className="flex flex-col">
                    <span className="text-blue-500 mb-0.5 font-bold">Upload</span>
                    <span className="text-blue-500 font-medium">{formatBytes(stats.netUp)}/s</span>
                </div>
                <div className="flex flex-col">
                    <span className="text-orange-500 mb-0.5 font-bold">Download</span>
                    <span className="text-orange-500 font-medium">{formatBytes(stats.netDown)}/s</span>
                </div>
            </div>
        </div>
      </CardContent>
    </Card>
  );
}
