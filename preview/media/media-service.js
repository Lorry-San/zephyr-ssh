const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VIDEO_EXTENSIONS = new Set([
    'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'f4v', 'mpeg', 'mpg', 'mpe',
    'ts', 'mts', 'm2ts', 'vob', 'ogv', '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx', 'mxf'
]);
const AUDIO_EXTENSIONS = new Set([
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'alac', 'aiff',
    'aif', 'ape', 'amr', 'mid', 'midi', 'mka', 'caf', 'ac3', 'dts', 'm4b'
]);
const SUBTITLE_EXTENSIONS = new Set(['vtt', 'srt', 'ass', 'ssa', 'sub']);
const DIRECT_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const DIRECT_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba']);
const DIRECT_MIME = new Map([
    ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['webm', 'video/webm'], ['ogv', 'video/ogg'],
    ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['aac', 'audio/aac'], ['wav', 'audio/wav'], ['flac', 'audio/flac'],
    ['ogg', 'audio/ogg'], ['oga', 'audio/ogg'], ['opus', 'audio/ogg'], ['weba', 'audio/webm']
]);
const MP4_CONTAINERS = new Set(['mp4', 'mov', 'm4v', '3gp', '3g2']);

function extname(filePath = '') {
    const base = String(filePath || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
}
function basenameNoExt(filePath = '') {
    const base = path.basename(String(filePath || ''));
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(0, idx) : base;
}
function isMediaExt(ext) { return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext); }
function isVideoExt(ext) { return VIDEO_EXTENSIONS.has(ext); }
function isAudioExt(ext) { return AUDIO_EXTENSIONS.has(ext); }
function isSubtitleExt(ext) { return SUBTITLE_EXTENSIONS.has(ext); }
function directMime(ext) { return DIRECT_MIME.get(ext) || 'application/octet-stream'; }
function mediaCacheKey(parts) { return crypto.createHash('sha256').update(parts.join('\0')).digest('hex'); }
function normalizeCodec(codec = '') {
    const value = String(codec || '').toLowerCase();
    if (value === 'h264' || value === 'avc' || value === 'mpeg4_avc') return 'h264';
    if (value === 'hevc' || value === 'h265') return 'hevc';
    if (value === 'aac_latm') return 'aac';
    return value;
}
function parseProbeJson(raw, fallbackExt = '') {
    const data = JSON.parse(raw || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const format = data.format || {};
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const subtitles = streams.filter((s) => s.codec_type === 'subtitle').map((s, index) => ({
        index,
        streamIndex: Number(s.index),
        codec: normalizeCodec(s.codec_name || ''),
        language: s.tags?.language || '',
        external: false,
    }));
    return {
        container: String(format.format_name || fallbackExt || '').split(',')[0],
        duration: Number(format.duration) || 0,
        bitrate: Number(format.bit_rate) || 0,
        video: videoStream ? {
            codec: normalizeCodec(videoStream.codec_name || ''),
            width: Number(videoStream.width) || 0,
            height: Number(videoStream.height) || 0,
            bitrate: Number(videoStream.bit_rate) || 0,
            hdr: /smpte|bt2020|arib/i.test([videoStream.color_transfer, videoStream.color_space, videoStream.color_primaries].filter(Boolean).join(' ')),
        } : null,
        audio: audioStream ? {
            codec: normalizeCodec(audioStream.codec_name || ''),
            channels: Number(audioStream.channels) || 0,
            bitrate: Number(audioStream.bit_rate) || 0,
        } : null,
        subtitles,
    };
}
function probeMediaFromStream(createReadStream, { cacheMap, cacheKey, ext = '', timeoutMs = 12000 } = {}) {
    if (cacheMap && cacheKey) {
        const cached = cacheMap.get(cacheKey);
        if (cached) { cached.expiresAt = Date.now() + 30 * 60 * 1000; return Promise.resolve(cached.info); }
    }
    return new Promise((resolve, reject) => {
        const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', 'pipe:0'];
        const child = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch {}
            reject(new Error('ffprobe 识别超时'));
        }, timeoutMs);
        const done = (err, info) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else {
                if (cacheMap && cacheKey) cacheMap.set(cacheKey, { info, expiresAt: Date.now() + 30 * 60 * 1000 });
                resolve(info);
            }
        };
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', done);
        child.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                try { done(null, parseProbeJson(stdout, ext)); } catch (err) { done(err); }
            } else done(new Error((stderr || `ffprobe 退出码 ${code}`).trim() || 'ffprobe 识别失败'));
        });
        const input = createReadStream();
        input.on('error', (err) => { try { child.stdin.destroy(err); } catch {} });
        child.stdin.on('error', () => {});
        input.pipe(child.stdin);
    });
}
function decidePlayMode(info, ext, capabilities = {}) {
    const isVideo = !!info?.video || isVideoExt(ext);
    const videoCodec = normalizeCodec(info?.video?.codec || '');
    const audioCodec = normalizeCodec(info?.audio?.codec || '');
    const videoKey = videoCodec === 'h264' ? 'h264' : videoCodec;
    const audioKey = audioCodec === 'aac' ? 'aac' : audioCodec;
    const container = String(info?.container || ext || '').toLowerCase();
    const browserVideo = capabilities?.video || {};
    const browserAudio = capabilities?.audio || {};
    const videoSupported = !isVideo || browserVideo[videoKey] === true;
    const audioSupported = !audioCodec || browserAudio[audioKey] === true;
    const mp4Like = MP4_CONTAINERS.has(ext) || MP4_CONTAINERS.has(container);
    if (!isVideo && DIRECT_AUDIO_EXTENSIONS.has(ext) && audioSupported) return 'DIRECT';
    if (isVideo && mp4Like && videoCodec === 'h264' && (!audioCodec || audioCodec === 'aac') && videoSupported && audioSupported) return 'DIRECT';
    if (isVideo && DIRECT_VIDEO_EXTENSIONS.has(ext) && videoSupported && audioSupported) return 'DIRECT';
    if (isVideo && videoSupported && !audioSupported) return 'AUDIO_TRANSCODE';
    if (isVideo && videoSupported) return 'REMUX';
    return isVideo ? 'FULL_TRANSCODE' : 'AUDIO_TRANSCODE';
}
function ffmpegArgsForMode(mode, isVideo, input = 'pipe:0') {
    const common = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-i', input];
    if (!isVideo) return [...common, '-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
    if (mode === 'REMUX') return [...common, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
    if (mode === 'AUDIO_TRANSCODE') return [...common, '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
    return [...common, '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
}
function subtitleToVttArgs(index = 0) {
    return ['-hide_banner', '-loglevel', 'warning', '-i', 'pipe:0', '-map', `0:s:${Math.max(0, Number(index) || 0)}`, '-f', 'webvtt', 'pipe:1'];
}
function cleanupMediaProbeCache(cacheMap) {
    const now = Date.now();
    for (const [key, item] of cacheMap.entries()) if (!item?.expiresAt || item.expiresAt <= now) cacheMap.delete(key);
}
module.exports = {
    VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS,
    extname, basenameNoExt, isMediaExt, isVideoExt, isAudioExt, isSubtitleExt, directMime,
    mediaCacheKey, probeMediaFromStream, decidePlayMode, ffmpegArgsForMode, subtitleToVttArgs,
    cleanupMediaProbeCache,
};
