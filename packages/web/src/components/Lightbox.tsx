import { useEffect } from 'react';
import { IconClose } from './icons';

/** A picture at full size over everything; a tap anywhere closes it. */
export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="图片" onClick={onClose}>
      <img src={url} alt="放大的图片" />
      <button type="button" className="lightbox-close" aria-label="关闭" onClick={onClose}>
        <IconClose size={18} />
      </button>
    </div>
  );
}
