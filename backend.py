from fastapi import FastAPI, Query
import yt_dlp

app = FastAPI()

@app.get("/video/")
async def get_video(video_url: str = Query(..., title="YouTube Video URL")):
    ydl_opts = {
        'format': 'best',
        'noplaylist': True,
        'quiet': True
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(video_url, download=False)
            return {
                "title": info.get("title"),
                "url": info.get("url"),
                "thumbnail": info.get("thumbnail"),
                "duration": info.get("duration")
            }
        except Exception as e:
            return {"error": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=True)
