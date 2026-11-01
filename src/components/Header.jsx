import React from 'react';
import { ShieldCheck, Video } from 'lucide-react';

export default function Header({ subtitle = 'PRIVATE CAMERA SESSIONS' }) {
  return (
    <header className="border-b border-slate-800/80 bg-slate-950/60 backdrop-blur-md sticky top-0 z-40 transition-colors">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <a 
          href="/" 
          className="flex items-center gap-3 text-slate-100 hover:text-white transition-opacity group no-underline"
          title="Fieldlink Home"
        >
          <div className="relative w-7 h-7 rounded-lg border-2 border-sky-400 rotate-[-8deg] flex items-center justify-center transition-transform group-hover:rotate-0 duration-200">
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
            <Video className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <span className="font-bold tracking-tight text-lg text-white font-sans">
            field<span className="text-sky-400 font-extrabold">link</span>
          </span>
        </a>

        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium tracking-wider bg-slate-900 border border-slate-800 text-slate-400 uppercase">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            {subtitle}
          </span>
        </div>
      </div>
    </header>
  );
}
