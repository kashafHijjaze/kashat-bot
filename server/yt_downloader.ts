import yts from 'yt-search';

export interface YtVideoResult {
  title: string;
  url: string;
  videoId: string;
  author: string;
  duration: string;
  ago: string;
  views: string;
  seconds: number;
  image: string;
  thumbnail: string;
}

export async function searchYouTubeVideo(query: string): Promise<YtVideoResult | null> {
  try {
    const searchResult = await yts(query);
    const videos = searchResult?.videos || [];
    if (!videos || videos.length === 0) {
      return null;
    }

    const best = videos.find((v: any) => v.seconds && v.seconds <= 900) || videos[0];
    const imgUrl = best.image || best.thumbnail || (best.videoId ? `https://i.ytimg.com/vi/${best.videoId}/hqdefault.jpg` : '');

    return {
      title: best.title || 'Untitled Video',
      url: best.url || `https://www.youtube.com/watch?v=${best.videoId}`,
      videoId: best.videoId || '',
      author: best.author?.name || 'Unknown Channel',
      duration: best.timestamp || (best.seconds ? `${Math.floor(best.seconds / 60)}:${best.seconds % 60}` : 'Unknown'),
      ago: best.ago || 'Recently',
      views: best.views ? best.views.toLocaleString() : 'N/A',
      seconds: best.seconds || 0,
      image: imgUrl,
      thumbnail: imgUrl
    };
  } catch (err) {
    console.error('[YtSearch] Error searching YouTube video:', err);
    return null;
  }
}

export async function searchYouTubeAudio(query: string): Promise<YtVideoResult | null> {
  try {
    const searchResult = await yts(query);
    const videos = searchResult?.videos || [];
    if (!videos || videos.length === 0) {
      return null;
    }

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    // Score and rank candidates
    let bestVideo = videos[0];
    let bestScore = -999;

    for (let i = 0; i < Math.min(videos.length, 15); i++) {
      const v = videos[i];
      let score = 15 - i; // Position score

      const titleLower = (v.title || '').toLowerCase();
      const authorLower = (v.author?.name || '').toLowerCase();

      // Word match bonus
      let matchedWords = 0;
      for (const word of queryWords) {
        if (titleLower.includes(word) || authorLower.includes(word)) {
          matchedWords++;
        }
      }
      score += matchedWords * 10;

      // Official / Verified channel / title bonus
      if (
        authorLower.includes('official') || 
        authorLower.includes('vevo') || 
        authorLower.includes('topic') ||
        titleLower.includes('official audio') ||
        titleLower.includes('official video') ||
        titleLower.includes('full audio') ||
        titleLower.includes('original')
      ) {
        score += 15;
      }

      // Views bonus
      if (v.views) {
        score += Math.min(15, Math.log10(v.views) * 2);
      }

      // Duration penalty (prefer reasonable audio under 20 mins = 1200s)
      if (v.seconds && v.seconds > 1200) {
        score -= 50;
      } else if (v.seconds && v.seconds >= 60 && v.seconds <= 600) {
        score += 10; // Optimal song length (1 to 10 mins)
      }

      if (score > bestScore) {
        bestScore = score;
        bestVideo = v;
      }
    }

    const imgUrl = bestVideo.image || bestVideo.thumbnail || (bestVideo.videoId ? `https://i.ytimg.com/vi/${bestVideo.videoId}/hqdefault.jpg` : '');

    return {
      title: bestVideo.title || 'Untitled Audio',
      url: bestVideo.url || `https://www.youtube.com/watch?v=${bestVideo.videoId}`,
      videoId: bestVideo.videoId || '',
      author: bestVideo.author?.name || 'Unknown Artist',
      duration: bestVideo.timestamp || (bestVideo.seconds ? `${Math.floor(bestVideo.seconds / 60)}:${bestVideo.seconds % 60}` : 'Unknown'),
      ago: bestVideo.ago || 'Recently',
      views: bestVideo.views ? bestVideo.views.toLocaleString() : 'N/A',
      seconds: bestVideo.seconds || 0,
      image: imgUrl,
      thumbnail: imgUrl
    };
  } catch (err) {
    console.error('[YtSearch] Error searching YouTube audio:', err);
    return null;
  }
}

async function downloadFromLoaderToAudio(videoUrl: string, format = 'mp3'): Promise<{ buffer: Buffer; mimetype: string } | null> {
  try {
    console.log(`[YtDownloader] Attempting Loader.to audio engine (${format}) for:`, videoUrl);
    const initRes = await fetch(`https://loader.to/ajax/download.php?format=${format}&url=${encodeURIComponent(videoUrl)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://loader.to/'
      }
    });
    if (!initRes.ok) return null;
    const initData: any = await initRes.json();
    if (!initData || !initData.id) return null;

    const progUrl = initData.progress_url || `https://loader.to/ajax/progress.php?id=${initData.id}`;

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const progRes = await fetch(progUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://loader.to/'
          }
        });
        if (!progRes.ok) continue;
        const progData: any = await progRes.json();

        let finalUrl = progData?.download_url || progData?.url || progData?.file;

        if (!finalUrl && progData?.content) {
          try {
            const html = Buffer.from(progData.content, 'base64').toString('utf-8');
            const match = html.match(/href="(https:\/\/[^"]+)"/i);
            if (match && match[1] && match[1].includes('http')) {
              finalUrl = match[1];
            }
          } catch (e) {}
        }

        if (finalUrl && typeof finalUrl === 'string' && finalUrl.startsWith('http')) {
          console.log('[YtDownloader] Loader.to audio download link obtained:', finalUrl);
          const audioRes = await fetch(finalUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://loader.to/'
            }
          });
          if (audioRes.ok) {
            const arrayBuf = await audioRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            if (buffer.length > 100000) {
              return { buffer, mimetype: 'audio/mpeg' };
            }
          }
        }
      } catch (pollErr: any) {
        // Quiet retry next iteration
      }
    }
  } catch (e: any) {
    // Quiet catch
  }
  return null;
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export async function downloadAudioBuffer(videoUrl: string, videoId: string): Promise<{ buffer: Buffer; mimetype: string; sizeFormatted: string }> {
  // 1. Primary Engine: Loader.to mp3
  const a1 = await downloadFromLoaderToAudio(videoUrl, 'mp3');
  if (a1) {
    return {
      buffer: a1.buffer,
      mimetype: a1.mimetype,
      sizeFormatted: formatBytes(a1.buffer.length)
    };
  }

  // 2. Loader.to fallback format 320
  const a2 = await downloadFromLoaderToAudio(videoUrl, '320');
  if (a2) {
    return {
      buffer: a2.buffer,
      mimetype: a2.mimetype,
      sizeFormatted: formatBytes(a2.buffer.length)
    };
  }

  // 3. Fallback Backup YTMP3 APIs
  const backupApis = [
    `https://api.vreden.web.id/api/ytmp3?url=${encodeURIComponent(videoUrl)}`,
    `https://api.guruapi.tech/ytmp3?url=${encodeURIComponent(videoUrl)}`,
    `https://api.dreaded.site/api/ytdl/audio?url=${encodeURIComponent(videoUrl)}`,
    `https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(videoUrl)}`
  ];

  for (const apiUrl of backupApis) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data: any = await res.json();
      const dlUrl = data?.result?.download?.url || data?.result?.url || data?.data?.dl || data?.url;
      if (dlUrl && typeof dlUrl === 'string') {
        const audioRes = await fetch(dlUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (audioRes.ok) {
          const arrayBuf = await audioRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          if (buffer.length > 100000) {
            return {
              buffer,
              mimetype: 'audio/mpeg',
              sizeFormatted: formatBytes(buffer.length)
            };
          }
        }
      }
    } catch (e: any) {
      // Quietly continue to next backup API
    }
  }

  throw new Error('Failed to download the audio. The track may be restricted or temporarily unavailable.');
}


async function downloadFromLoaderTo(videoUrl: string, format = '360'): Promise<{ buffer: Buffer; mimetype: string } | null> {
  try {
    console.log(`[YtDownloader] Attempting Loader.to engine (${format}p) for:`, videoUrl);
    const initRes = await fetch(`https://loader.to/ajax/download.php?format=${format}&url=${encodeURIComponent(videoUrl)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://loader.to/'
      }
    });
    if (!initRes.ok) return null;
    const initData: any = await initRes.json();
    if (!initData || !initData.id) return null;

    const progUrl = initData.progress_url || `https://loader.to/ajax/progress.php?id=${initData.id}`;

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const progRes = await fetch(progUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://loader.to/'
          }
        });
        if (!progRes.ok) continue;
        const progData: any = await progRes.json();

        let finalUrl = progData?.download_url || progData?.url || progData?.file;

        if (!finalUrl && progData?.content) {
          try {
            const html = Buffer.from(progData.content, 'base64').toString('utf-8');
            const match = html.match(/href="(https:\/\/[^"]+)"/i);
            if (match && match[1] && match[1].includes('http')) {
              finalUrl = match[1];
            }
          } catch (e) {}
        }

        if (finalUrl && typeof finalUrl === 'string' && finalUrl.startsWith('http')) {
          console.log('[YtDownloader] Loader.to download link obtained:', finalUrl);
          const vidRes = await fetch(finalUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://loader.to/'
            }
          });
          if (vidRes.ok) {
            const arrayBuf = await vidRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            if (buffer.length > 200000) {
              return { buffer, mimetype: 'video/mp4' };
            }
          }
        }
      } catch (pollErr: any) {
        // Quiet retry next iteration
      }
    }
  } catch (e: any) {
    // Quiet catch
  }
  return null;
}

export async function downloadVideoBuffer(videoUrl: string, videoId: string): Promise<{ buffer: Buffer; mimetype: string }> {
  // 1. Primary Engine: Loader.to (360p)
  const l1 = await downloadFromLoaderTo(videoUrl, '360');
  if (l1) return l1;

  // 2. Loader.to fallback (480p / 720p)
  const l2 = await downloadFromLoaderTo(videoUrl, '480');
  if (l2) return l2;

  const l3 = await downloadFromLoaderTo(videoUrl, '720');
  if (l3) return l3;

  // 3. Fallback Backup YTMP4 APIs (15s timeout for video streams)
  const backupApis = [
    `https://api.vreden.web.id/api/ytmp4?url=${encodeURIComponent(videoUrl)}`,
    `https://widipe.com/download/ytdl?url=${encodeURIComponent(videoUrl)}`,
    `https://api.guruapi.tech/ytmp4?url=${encodeURIComponent(videoUrl)}`,
    `https://api.dreaded.site/api/ytdl/video?url=${encodeURIComponent(videoUrl)}`,
    `https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(videoUrl)}`
  ];

  for (const apiUrl of backupApis) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data: any = await res.json();
      const dlUrl = data?.result?.download?.url || data?.result?.url || data?.data?.dl || data?.data?.url || data?.url;
      if (dlUrl && typeof dlUrl === 'string' && dlUrl.startsWith('http')) {
        const vidRes = await fetch(dlUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });
        if (vidRes.ok) {
          const arrayBuf = await vidRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          if (buffer.length > 200000) {
            return { buffer, mimetype: 'video/mp4' };
          }
        }
      }
    } catch (e: any) {
      // Quietly continue to next backup API
    }
  }

  throw new Error('Unable to download video from available servers. The video may be restricted, private, or temporarily unavailable.');
}

