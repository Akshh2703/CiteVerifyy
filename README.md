# CiteVerify prototype

## Frontend (current UI prototype)
Requires Node.js 18+.
```bash
npm install
npm run dev
```

## Backend API (document parsing / citation triage scaffold)
Requires Python 3.10+.

Windows PowerShell:
```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

macOS/Linux:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs
Health: http://localhost:8000/api/health

## Important limitations
- Frontend is not yet connected to the backend API.
- Backend parses documents and extracts heuristic claim/citation candidates, matches citations to references, and offers scholarly metadata/OA discovery endpoints.
- It does **not** yet perform AI claim extraction or authoritative claim-vs-source verification. Verdicts remain Unverifiable until evidence is assessed.
- Metadata search/abstracts are not proof. Restricted full text is not bypassed.
- Scanned PDFs need OCR, which is not enabled.

## Windows quick start

1. Install Node.js LTS and Python 3.10+ if not already installed.
2. Double-click `start-backend.bat` to install backend dependencies (first run only) and start FastAPI on port 8000.
3. Double-click `start-frontend.bat` to install frontend dependencies (first run only) and start Vite.
4. Open the localhost URL printed by Vite.
5. For LLM chat, set `GROQ_API_KEY` in a CMD window before starting the backend: `set GROQ_API_KEY=YOUR_KEY`.


The API supports local frontend origins on localhost/127.0.0.1 and any port via CORS regex for development.
