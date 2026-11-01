import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, Check, Copy } from 'lucide-react';

export default function QrCodeModal({ url, onClose }) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, {
      width: 320,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then(setQrDataUrl)
      .catch((err) => console.error('Failed to generate QR code', err));
  }, [url]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-700/80 bg-slate-900 p-6 shadow-2xl">
        <button
          onClick={onClose}
          type="button"
          aria-label="Close modal"
          className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 mb-4 text-sky-400">
          <Smartphone className="w-5 h-5" />
          <h3 className="text-base font-semibold text-white">Scan with your Phone</h3>
        </div>

        <p className="text-xs text-slate-400 mb-5 leading-relaxed">
          Open your smartphone's camera or QR reader to instantly open this private camera session.
        </p>

        <div className="flex justify-center p-4 bg-white rounded-xl shadow-inner mb-4">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Session QR Code" className="w-60 h-60 object-contain rounded" />
          ) : (
            <div className="w-60 h-60 flex items-center justify-center text-slate-500 text-sm">
              Generating QR Code…
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={url}
            className="flex-1 px-3 py-2 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-300 truncate focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1.5"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
