import React from 'react';

export default function StatusDot({ status = 'neutral', pulse = false, size = 'md' }) {
  const sizeClasses = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3 h-3',
  }[size] || 'w-2.5 h-2.5';

  const colorClasses = {
    good: 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]',
    warn: 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)]',
    bad: 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]',
    neutral: 'bg-slate-500',
  }[status] || 'bg-slate-500';

  return (
    <span className="relative inline-flex items-center justify-center flex-shrink-0">
      {pulse && status === 'good' && (
        <span className={`absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping`} />
      )}
      <span className={`inline-block rounded-full ${sizeClasses} ${colorClasses} transition-all duration-300`} />
    </span>
  );
}
