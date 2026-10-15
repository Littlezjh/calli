import { useEffect, useRef, useState } from 'react';
import type { VideoRef } from '../api';
import { sizeLabel } from '../files';
import { PanelDialog } from './Dialog';
import { IconDownload, IconPlay } from './icons';

export function VideoPreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  return <PanelDialog title={name} onClose={onClose} className="video-preview">
    <video src={url} controls playsInline preload="metadata" onError={() => setFailed(true)} />
    <div className="video-preview-footer">
      <span>{failed ? '浏览器无法播放这个编码，可以下载原视频' : '原视频'}</span>
      <a href={url} download={name}><IconDownload size={15} />下载视频</a>
    </div>
  </PanelDialog>;
}

/** Fetch only on demand; opening a thread must not download every video in its history. */
export function SentVideo({ video, load }: { video: VideoRef; load: (id: string) => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const open = async () => {
    setLoading(true);
    setError(false);
    try {
      const blob = await load(video.id);
      if (alive.current) setUrl(URL.createObjectURL(blob));
    } catch { if (alive.current) setError(true); }
    finally { if (alive.current) setLoading(false); }
  };
  return <>
    <button type="button" className="video-card" disabled={loading} onClick={() => void open()} aria-label={`播放视频：${video.name}`}>
      <IconPlay size={20} /><span><span className="video-name">{video.name}</span><span className="video-size">{loading ? '加载视频…' : error ? '加载失败，点击重试' : sizeLabel(video.size)}</span></span>
    </button>
    {url && <VideoPreview url={url} name={video.name} onClose={() => setUrl(null)} />}
  </>;
}
