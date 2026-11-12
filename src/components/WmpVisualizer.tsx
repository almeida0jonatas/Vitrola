import React, { useEffect, useRef, useState, useCallback } from 'react';
import { initAudioAnalyser, resumeAudioContext } from '../utils/audioVisualizer';

interface WmpVisualizerProps {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  isPlaying: boolean;
  trackTitle?: string;
  artistName?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onClose?: () => void;
}

export const WmpVisualizer: React.FC<WmpVisualizerProps> = ({
  audioRef,
  isPlaying,
  trackTitle,
  artistName,
  isFullscreen = false,
  onToggleFullscreen,
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Peak hold state for 32 frequency bars (classic Windows Media Player gravity physics)
  const barCount = 32;
  const peaksRef = useRef<Float32Array>(new Float32Array(barCount));
  const peakSpeedRef = useRef<Float32Array>(new Float32Array(barCount));
  const smoothHeightsRef = useRef<Float32Array>(new Float32Array(barCount));

  // Procedural fallback phase for when audio data is 0 or paused
  const phaseRef = useRef<number>(0);

  // Auto-hide controls in fullscreen after inactivity
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  const resetHideTimer = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 2800);
  }, []);

  useEffect(() => {
    resetHideTimer();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [resetHideTimer, isFullscreen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let analyser: AnalyserNode | null = null;
    if (audioRef.current) {
      analyser = initAudioAnalyser(audioRef.current);
    }

    const freqData = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);
    const timeData = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);

    const resize = () => {
      const container = containerRef.current;
      if (!container || !canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }
    };

    resize();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(resize);
      ro.observe(containerRef.current);
    }
    window.addEventListener('resize', resize);

    const render = () => {
      if (!canvas || !ctx) return;
      const w = canvas.width;
      const h = canvas.height;

      if (w === 0 || h === 0) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      // Read audio data if analyser is ready
      let hasRealAudio = false;
      if (analyser && isPlaying) {
        resumeAudioContext();
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData);

        for (let i = 0; i < 20; i++) {
          if (freqData[i] > 8) {
            hasRealAudio = true;
            break;
          }
        }
      }

      phaseRef.current += isPlaying ? 0.045 : 0.015;
      const phase = phaseRef.current;

      // 1. Clear background with deep Windows Media Player radial glow
      ctx.save();
      const bgGrad = ctx.createRadialGradient(
        w * 0.5,
        h * 0.45,
        Math.min(w, h) * 0.1,
        w * 0.5,
        h * 0.5,
        Math.max(w, h) * 0.85
      );
      bgGrad.addColorStop(0, '#0d1527');
      bgGrad.addColorStop(0.5, '#070a14');
      bgGrad.addColorStop(1, '#020409');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Bass energy pulse (sub-woofer ambience aura)
      let bassEnergy = 0;
      if (hasRealAudio) {
        for (let i = 0; i < 8; i++) bassEnergy += freqData[i];
        bassEnergy = bassEnergy / (8 * 255);
      } else if (isPlaying) {
        bassEnergy = (Math.sin(phase * 1.5) + 1) * 0.25;
      }

      if (bassEnergy > 0.05) {
        ctx.beginPath();
        const auraRadius = (Math.min(w, h) * 0.22) * (1 + bassEnergy * 0.4);
        const auraGrad = ctx.createRadialGradient(w * 0.5, h * 0.55, 0, w * 0.5, h * 0.55, auraRadius);
        auraGrad.addColorStop(0, `rgba(0, 229, 255, ${0.18 * bassEnergy})`);
        auraGrad.addColorStop(0.6, `rgba(112, 0, 255, ${0.08 * bassEnergy})`);
        auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = auraGrad;
        ctx.arc(w * 0.5, h * 0.55, auraRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Baseline parameters
      const baselineY = h * 0.68;
      const maxBarH = h * 0.44;
      const totalWidth = w * 0.88;
      const startX = (w - totalWidth) * 0.5;
      const slotWidth = totalWidth / barCount;
      const barWidth = Math.max(3, slotWidth * 0.72);
      const gap = slotWidth - barWidth;

      const peaks = peaksRef.current;
      const peakSpeed = peakSpeedRef.current;
      const smoothHeights = smoothHeightsRef.current;
      const gravity = 0.55 * (h / 400);

      // 2. Compute bar heights & draw Spectrum Bars (WMP Bars)
      for (let i = 0; i < barCount; i++) {
        let rawNorm = 0;
        if (hasRealAudio) {
          // Logarithmic / perceptually grouped bins
          const binIdx = Math.min(
            freqData.length - 1,
            Math.floor(Math.pow(i / barCount, 1.45) * (freqData.length * 0.85)) + 1
          );
          rawNorm = freqData[binIdx] / 255;
          // slight boost on higher frequencies
          rawNorm = Math.min(1, rawNorm * (1 + (i / barCount) * 0.5));
        } else if (isPlaying) {
          // Procedural standby music pulse
          const harmonic1 = Math.sin(phase * 1.8 + i * 0.22);
          const harmonic2 = Math.cos(phase * 2.7 - i * 0.35);
          rawNorm = Math.max(0.08, ((harmonic1 + harmonic2 + 2) / 4) * (1 - (i / barCount) * 0.35));
        } else {
          // Idle breathing ripple
          rawNorm = Math.max(0.02, 0.06 + Math.sin(phase * 0.8 + i * 0.25) * 0.035);
        }

        const targetH = rawNorm * maxBarH;
        smoothHeights[i] += (targetH - smoothHeights[i]) * 0.32;
        const curH = Math.max(2, smoothHeights[i]);

        // Peak physics (bouncing caps with gravity)
        if (curH >= peaks[i]) {
          peaks[i] = curH;
          peakSpeed[i] = 0;
        } else {
          peakSpeed[i] += gravity;
          peaks[i] = Math.max(0, peaks[i] - peakSpeed[i]);
        }

        const bx = startX + i * slotWidth + gap * 0.5;
        const by = baselineY - curH;

        // Draw main frequency bar with WMP cyan-to-emerald neon gradient
        const barGrad = ctx.createLinearGradient(0, baselineY, 0, by);
        barGrad.addColorStop(0, '#00e5ff');
        barGrad.addColorStop(0.55, '#00ff9d');
        barGrad.addColorStop(0.85, '#76ff03');
        barGrad.addColorStop(1, '#ffea00');

        ctx.fillStyle = barGrad;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(bx, by, barWidth, curH, [barWidth * 0.35, barWidth * 0.35, 0, 0]);
        } else {
          ctx.rect(bx, by, barWidth, curH);
        }
        ctx.fill();

        // Draw Peak Cap (floating horizontal tick)
        const peakY = baselineY - peaks[i] - 3;
        if (peakY < baselineY - 4) {
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = '#00e5ff';
          ctx.shadowBlur = 4;
          ctx.fillRect(bx, peakY, barWidth, Math.max(2, barWidth * 0.28));
          ctx.shadowBlur = 0;
        }

        // Draw mirror reflection (dimmed glassy bottom floor)
        const reflH = curH * 0.38;
        const reflGrad = ctx.createLinearGradient(0, baselineY, 0, baselineY + reflH);
        reflGrad.addColorStop(0, 'rgba(0, 229, 255, 0.32)');
        reflGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = reflGrad;
        ctx.fillRect(bx, baselineY + 2, barWidth, reflH);
      }

      // Baseline separator line
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(startX - 6, baselineY);
      ctx.lineTo(startX + totalWidth + 6, baselineY);
      ctx.stroke();

      // 3. Draw Oscilloscope Waveform (WMP Waves)
      const waveY = h * 0.36;
      const waveAmp = h * 0.14;
      ctx.save();
      ctx.strokeStyle = '#00ffff';
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2.4;
      ctx.beginPath();

      const wavePoints = 64;
      for (let j = 0; j < wavePoints; j++) {
        const wx = startX + (j / (wavePoints - 1)) * totalWidth;
        let wy = waveY;

        if (hasRealAudio) {
          const sampleIdx = Math.floor((j / wavePoints) * timeData.length);
          const normSample = (timeData[sampleIdx] - 128) / 128; // -1 to 1
          wy = waveY + normSample * waveAmp;
        } else if (isPlaying) {
          const sine = Math.sin(phase * 3 + j * 0.28) * 0.6 + Math.sin(phase * 1.5 + j * 0.48) * 0.4;
          wy = waveY + sine * (waveAmp * 0.6);
        } else {
          wy = waveY + Math.sin(phase * 1.2 + j * 0.15) * (waveAmp * 0.15);
        }

        if (j === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      }
      ctx.stroke();

      // Secondary oscilloscope ghost wave (stereophonic feel)
      ctx.strokeStyle = 'rgba(157, 0, 255, 0.55)';
      ctx.lineWidth = 1.6;
      ctx.shadowColor = '#9d00ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let j = 0; j < wavePoints; j++) {
        const wx = startX + (j / (wavePoints - 1)) * totalWidth;
        let wy = waveY;
        if (hasRealAudio) {
          const sampleIdx = Math.floor(((wavePoints - 1 - j) / wavePoints) * timeData.length);
          const normSample = (timeData[sampleIdx] - 128) / 128;
          wy = waveY - normSample * waveAmp * 0.75;
        } else if (isPlaying) {
          wy = waveY - Math.cos(phase * 2.4 + j * 0.25) * (waveAmp * 0.4);
        } else {
          wy = waveY - Math.sin(phase * 0.9 + j * 0.18) * (waveAmp * 0.12);
        }
        if (j === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      }
      ctx.stroke();
      ctx.restore();

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [audioRef, isPlaying]);

  return (
    <div
      ref={containerRef}
      className={`wmp-visualizer-container ${isFullscreen ? 'fullscreen' : 'stage'}`}
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
      onClick={() => {
        resetHideTimer();
      }}
    >
      <canvas ref={canvasRef} className="wmp-visualizer-canvas" />

      {/* Top Header Controls Overlay */}
      <div className={`wmp-vis-overlay top ${controlsVisible || !isFullscreen ? 'visible' : ''}`}>
        <div className="wmp-vis-badge">
          <span className="wmp-logo-dot" />
          <span className="wmp-title-text">Windows Media Player</span>
          <span className="wmp-mode-text">Barras e ondas</span>
        </div>

        <div className="wmp-vis-actions">
          {onToggleFullscreen && (
            <button
              type="button"
              className="wmp-vis-btn"
              title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
              aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFullscreen();
              }}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              )}
            </button>
          )}

          {onClose && (
            <button
              type="button"
              className="wmp-vis-btn"
              title="Voltar à capa do álbum"
              aria-label="Fechar visualização"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Bottom Track Meta Watermark */}
      {(trackTitle || artistName) && (
        <div className={`wmp-vis-overlay bottom ${controlsVisible || !isFullscreen ? 'visible' : ''}`}>
          <div className="wmp-vis-meta">
            {trackTitle && <b className="wmp-vis-song">{trackTitle}</b>}
            {artistName && <small className="wmp-vis-artist">{artistName}</small>}
          </div>
          <div className="wmp-vis-hint">
            {isFullscreen ? 'Toque na tela para controles' : 'Toque para alternar ou tela cheia'}
          </div>
        </div>
      )}
    </div>
  );
};
