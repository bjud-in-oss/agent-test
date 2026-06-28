import React, { useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw, Folder, FileText, Download, Copy, X } from 'lucide-react';

interface WorkspaceItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface WorkspaceTabProps {
  currentDir: string;
  fetchingFile: boolean;
  workspaceError: string | null;
  workspaceItems: WorkspaceItem[];
  navigateUp: () => void;
  loadWorkspace: (dir: string) => void;
  downloadFile: (path: string) => void;
}

export function WorkspaceTab({
  currentDir,
  fetchingFile,
  workspaceError,
  workspaceItems,
  navigateUp,
  loadWorkspace,
  downloadFile
}: WorkspaceTabProps) {
  const [viewingFile, setViewingFile] = useState<{name: string, path: string, content: string} | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleOpenFile = async (item: WorkspaceItem) => {
    if (item.isDirectory) {
      loadWorkspace(item.path);
      return;
    }
    
    setLoadingContent(true);
    try {
      const res = await fetch(`/api/workspace/read?path=${encodeURIComponent(item.path)}`);
      const data = await res.json();
      if (res.ok) {
        setViewingFile({ name: item.name, path: item.path, content: data.content });
      } else {
        alert(data.error || "Could not read file.");
      }
    } catch (err) {
      alert("Failed to fetch file content.");
    } finally {
      setLoadingContent(false);
    }
  };

  const handleCopy = () => {
    if (viewingFile) {
      navigator.clipboard.writeText(viewingFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (viewingFile) {
    return (
      <div className="flex flex-col gap-4 overflow-hidden h-[400px] lg:h-full relative">
        <div className="flex justify-between items-center shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => setViewingFile(null)} className="text-[#666] hover:text-[#121212] p-1">
               <ArrowLeft className="w-4 h-4" />
            </button>
            <p className="text-xs font-bold text-[#121212] font-mono">{viewingFile.name}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => downloadFile(viewingFile.path)} className="border border-[#121212] text-[#121212] px-3 py-1.5 font-bold uppercase text-[10px] flex items-center gap-2 hover:bg-[#121212] hover:text-white transition-colors">
              <Download className="w-3 h-3" />
            </button>
            <button onClick={handleCopy} className="bg-[#121212] text-white px-3 py-1.5 font-bold uppercase text-[10px] flex items-center gap-2 hover:bg-black transition-colors">
              {copied ? "Copied!" : <><Copy className="w-3 h-3" /> Copy</>}
            </button>
          </div>
        </div>
        <div className="flex-1 bg-[#121212] text-[#E5E5E5] p-4 overflow-y-auto font-mono text-[11px] lg:text-xs leading-relaxed shadow-sm">
           <pre className="whitespace-pre-wrap break-words">{viewingFile.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 overflow-hidden h-[400px] lg:h-full">
      <div className="flex justify-between items-center shrink-0">
         <div className="flex items-center gap-2">
            {currentDir && (
               <button onClick={navigateUp} className="text-[#666] hover:text-[#121212] p-1">
                  <ArrowLeft className="w-3 h-3" />
               </button>
            )}
            <p className="text-xs text-[#666] font-mono">{currentDir ? `/${currentDir}` : '/ (Root)'}</p>
         </div>
         <button onClick={() => loadWorkspace(currentDir)} disabled={fetchingFile || loadingContent} className="bg-[#121212] text-white px-4 py-2 font-bold uppercase text-[10px] flex items-center gap-2 hover:bg-black transition-colors disabled:opacity-50">
            {(fetchingFile || loadingContent) ? <Loader2 className="w-3 h-3 animate-spin"/> : <RefreshCw className="w-3 h-3" />} Refresh
         </button>
      </div>

      <div className="flex-1 bg-white border border-[#E5E5E5] shadow-sm overflow-y-auto">
         {workspaceError ? (
            <div className="p-6 text-[#FF4500] font-mono text-sm">{workspaceError}</div>
         ) : workspaceItems.length === 0 ? (
            <div className="p-6 text-[#999] italic flex items-center justify-center h-full">Workspace is empty.</div>
         ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E5E5E5] text-[10px] uppercase tracking-widest text-[#666]">
                  <th className="p-4 font-bold max-w-[200px]">Name</th>
                  <th className="p-4 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {workspaceItems.map((item, i) => (
                  <tr key={i} className="border-b border-[#E5E5E5] last:border-b-0 hover:bg-[#F9F9F9] transition-colors group cursor-pointer" onClick={() => handleOpenFile(item)}>
                    <td className="p-4 flex items-center gap-3">
                      {item.isDirectory ? <Folder className="w-4 h-4 text-[#0047AB]" /> : <FileText className="w-4 h-4 text-[#666]" />}
                      <span className={`font-mono text-sm truncate max-w-[200px] lg:max-w-[400px] ${item.isDirectory ? 'text-[#0047AB] font-bold' : 'text-[#121212]'}`}>
                         {item.name}{item.isDirectory && '/'}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      {!item.isDirectory && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); downloadFile(item.path); }}
                          className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 border border-[#121212] text-[#121212] hover:bg-[#121212] hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                        >
                          <Download className="w-3 h-3" /> DL
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
         )}
      </div>
    </div>
  );
}