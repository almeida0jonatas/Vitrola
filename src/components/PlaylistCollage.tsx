import React from 'react';

interface PlaylistCollageProps {
  covers: string[];
  className?: string;
  large?: boolean;
}

export const PlaylistCollage: React.FC<PlaylistCollageProps> = ({
  covers,
  className = '',
  large = false,
}) => {
  const filtered = covers.filter(Boolean);

  if (filtered.length >= 4) {
    return (
      <div className={`pl-collage ${large ? 'large' : ''} ${className}`} aria-hidden="true">
        {filtered.slice(0, 4).map((c, i) => (
          <img key={i} src={c} alt="" className="pl-collage-tile" />
        ))}
      </div>
    );
  }

  if (filtered.length > 0) {
    return (
      <div className={`pl-collage ${large ? 'large' : ''} ${className}`} aria-hidden="true">
        <img src={filtered[0]} alt="" className="pl-collage-single" />
      </div>
    );
  }

  return (
    <div className={`pl-collage ${large ? 'large' : ''} ${className}`} aria-hidden="true">
      <div className="pl-collage-fallback">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: large ? 48 : 22, height: large ? 48 : 22 }}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </div>
    </div>
  );
};
