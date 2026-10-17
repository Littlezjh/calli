import type { Api, VideoRef } from './api';
import { t } from './i18n';

export const MAX_VIDEOS = 3;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
export interface PreparedVideo { id: string; name: string; file: File; previewUrl: string }

export const isVideo = (file: Pick<File, 'type' | 'name'>): boolean => file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name);

export function prepareVideo(file: File): PreparedVideo {
  if (!isVideo(file) || !/\.(mp4|mov|webm)$/i.test(file.name) && !['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type)) throw new Error(t('videos.wrongType'));
  if (!file.size) throw new Error(t('videos.empty'));
  if (file.size > MAX_VIDEO_BYTES) throw new Error(t('videos.tooLarge'));
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name || t('videos.video'), file, previewUrl: URL.createObjectURL(file) };
}

export async function restoreVideos(api: Api, threadId: string, videos: VideoRef[] = []): Promise<PreparedVideo[]> {
  const files = await Promise.all(videos.map(video => api.videoFile(threadId, video)));
  return files.map(prepareVideo);
}
