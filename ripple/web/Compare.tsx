import { useEffect, useRef, useState } from 'react';

/**
 * Synced before/after wipe. The "before" video is the clock; the "after" video is
 * re-synced whenever drift exceeds ~80ms. Click toggles play on both; dragging the
 * divider moves the wipe.
 */
export function Compare({ before, after }: { before: string; after: string }) {
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  const dragging = useRef(false);

  useEffect(() => {
    const b = beforeRef.current!;
    const a = afterRef.current!;
    const sync = () => {
      if (Math.abs(a.currentTime - b.currentTime) > 0.08) a.currentTime = b.currentTime;
    };
    const play = () => a.play().catch(() => {});
    const pause = () => a.pause();
    b.addEventListener('timeupdate', sync);
    b.addEventListener('play', play);
    b.addEventListener('pause', pause);
    b.addEventListener('seeked', sync);
    return () => {
      b.removeEventListener('timeupdate', sync);
      b.removeEventListener('play', play);
      b.removeEventListener('pause', pause);
      b.removeEventListener('seeked', sync);
    };
  }, [before, after]);

  const moveTo = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    setPct(Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100)));
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => dragging.current && moveTo(e.clientX);
    const onUp = () => (dragging.current = false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const togglePlay = () => {
    const b = beforeRef.current!;
    if (b.paused) b.play().catch(() => {});
    else b.pause();
  };

  return (
    <div className="compare" ref={wrapRef} onClick={togglePlay}>
      <video ref={beforeRef} src={before} muted playsInline loop preload="auto" />
      <div className="after-layer" style={{ clipPath: `inset(0 0 0 ${pct}%)` }}>
        <video
          ref={afterRef}
          src={after}
          muted
          playsInline
          loop
          preload="auto"
          style={{ width: wrapRef.current?.clientWidth ?? '100%' }}
        />
      </div>
      <span className="tag before">ORIGINAL</span>
      <span className="tag after">EDITED</span>
      <div
        className="divider"
        style={{ left: `${pct}%` }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          dragging.current = true;
        }}
      />
    </div>
  );
}
