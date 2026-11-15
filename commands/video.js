import yts from "yt-search";
import fs from "fs";
import path from "path";
import axios from "axios";
import { spawn } from "child_process";
import { checkLimitOrPremium } from "./premium.js";
import { queueYouTubeDownload, retryTransient } from "./youtubeDownloadQueue.js";
import { withYtDlpCookies } from "./ytDlpCookies.js";

const MAX_VIDEO_SIZE = 95 * 1024 * 1024;

function cleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error("VIDEO cleanup error:", err?.message || err);
  }
}

async function downloadStreamToFile(url, filePath) {
  const videoResponse = await axios({
    method: "get",
    url,
    responseType: "stream",
    timeout: 120000,
    maxContentLength: MAX_VIDEO_SIZE,
    maxBodyLength: MAX_VIDEO_SIZE
  });

  const writer = fs.createWriteStream(filePath);
  videoResponse.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    videoResponse.data.on("error", reject);
  });
}

async function downloadWithYtDlp(url, filePath) {
  const args = [
      "-f", "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--remux-video", "mp4",
      "--no-playlist",
      "--js-runtimes", "node",
      "--quiet",
      "--no-warnings",
      "--socket-timeout", "30",
      "--retries", "3",
      "-o", filePath,
      url
  ];

  await withYtDlpCookies(args, () => new Promise((resolve, reject) => {
    const ytdlp = spawn("yt-dlp", args);
    let stderr = "";
    ytdlp.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    ytdlp.on("error", reject);
    ytdlp.on("close", (code) => {
      if (code === 0 && fs.existsSync(filePath)) return resolve();
      reject(new Error(`yt-dlp failed (${code}): ${stderr}`));
    });
  }));
}

export async function videoCommand(sock, chatId, msg) {
  const sender = msg.key.participant || msg.key.remoteJid;
  
  console.log("📥 VIDEO command - Sender JID:", sender);

  if (!(await checkLimitOrPremium(sender, "video"))) {
    return sock.sendMessage(chatId, {
      text: "🚫 You've reached downloading limit.\n\n UPGRADE to Premium so you can download without limits for 1 month at K1,000 ONLY.\n\n📲 Withdrawal via Airtel code👉 *10249697* or TNM 089 006 1520 (Edison Chazumbwa).\n\n Contact admins at 0995551995, 0993702468, 0886219577 for help."
    }, { quoted: msg });
  }

  let inputPath = "";

  try {
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      "";

    const query = text.split(" ").slice(1).join(" ").trim();
    if (!query) {
      return sock.sendMessage(chatId, {
        text: "🎬 Usage: .video song name"
      }, { quoted: msg });
    }

    const search = await yts(query);
    if (!search.videos.length) {
      return sock.sendMessage(chatId, {
        text: "❌ No video results found."
      }, { quoted: msg });
    }

    const video = search.videos[0];

    // Temp folder safety
    if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");

    const safeTitle = video.title.replace(/[^\w\s]/gi, "").substring(0, 50);
    const outputId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    inputPath = path.join("tmp", `${outputId}-${safeTitle}-input.mp4`);

    await sock.sendMessage(chatId, {
      text: `🎬 Downloading video:\n*${video.title}*\n⏱️ Duration: ${video.duration?.timestamp || 'Unknown'}\n👀 Views: ${video.views?.toLocaleString() || 'Unknown'}\n\n⏳ Please wait...`
    }, { quoted: msg });

    let videoTitle = video.title;
    await queueYouTubeDownload(async () => {
      try {
        const encodedUrl = encodeURIComponent(video.url);
        const apiUrl = `https://ef-prime-md-ultra-apis.vercel.app/downloader/ytdlv2?url=${encodedUrl}&format=video`;
        console.log("VIDEO: requesting download URL from provider");

        const apiResponse = await retryTransient(
          () => axios.get(apiUrl, { timeout: 60000 }),
          "VIDEO API"
        );
        const videoData = apiResponse.data?.answer;
        const downloadUrl = videoData?.video_url ||
          (videoData?.video_url_hd && videoData.video_url_hd !== "No SD video URL available"
            ? videoData.video_url_hd
            : null);

        if (!videoData?.status || !downloadUrl) {
          throw new Error("Video API did not return a usable download URL.");
        }

        videoTitle = videoData.title || video.title;
        await retryTransient(
          () => downloadStreamToFile(downloadUrl, inputPath),
          "VIDEO API media download"
        );
      } catch (apiErr) {
        cleanup(inputPath);
        console.error("VIDEO API failed, trying yt-dlp fallback:", apiErr?.code || apiErr?.message || apiErr);
        await retryTransient(
          () => downloadWithYtDlp(video.url, inputPath),
          "VIDEO yt-dlp"
        );
      }
    });
    const stats = fs.statSync(inputPath);

    // WhatsApp/Railway free-tier guard.
    if (stats.size > MAX_VIDEO_SIZE) {
      cleanup(inputPath);
      return sock.sendMessage(chatId, {
        text: "⚠️ Video too large for WhatsApp.\nTry a shorter video."
      }, { quoted: msg });
    }

    console.log("✅ Video downloaded successfully, size:", stats.size);

    // Send as document to preserve downloadable file and avoid local video
    // transcoding on memory-limited hosts.
    await sock.sendMessage(chatId, {
      document: fs.readFileSync(inputPath),
      mimetype: "video/mp4",
      fileName: `${videoTitle}.mp4`,
      caption: `🎬 ${videoTitle}`
    }, { quoted: msg });

    cleanup(inputPath);

  } catch (e) {
    cleanup(inputPath);
    console.error("VIDEO ERROR:", e);
    
    const errorText = String(e?.message || e);
    let errorMsg = "The video download failed. Please try again later.";
    if (/not a bot|sign in to confirm/i.test(errorText)) {
      errorMsg = "YouTube is blocking downloads from the bot server right now. Please try again later.";
    } else if (/requested format is not available|only images are available/i.test(errorText)) {
      errorMsg = "YouTube did not provide a downloadable video format for that result. Try another video.";
    } else if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
      errorMsg = "Download timeout. The video might be too large or the server is slow.";
    } else if (e.response?.status) {
      errorMsg = `Video provider error: ${e.response.status} - ${e.response.statusText}`;
    }
    await sock.sendMessage(chatId, {
      text: errorMsg
    }, { quoted: msg });
  }
}
