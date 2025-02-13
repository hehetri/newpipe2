from fastapi import FastAPI, Query
import yt_dlp

app = FastAPI()

@app.get("/video/")
async def get_video(video_url: str = Query(..., title="YouTube Video URL")):
    ydl_opts = {
        'format': 'best',
        'noplaylist': True,
        'quiet': True,
        'cookies': 'cookies.txt'  # Adicionando os cookies do navegador
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(video_url, download=False)
            return {
                "title": info.get("title", "Título não encontrado"),
                "url": info.get("url", ""),
                "thumbnail": info.get("thumbnail", ""),
                "duration": info.get("duration", 0)
            }
        except Exception as e:
            return {"error": f"Erro ao obter vídeo: {str(e)}"}
