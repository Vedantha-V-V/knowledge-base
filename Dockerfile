FROM python:3.10

WORKDIR /app

COPY backend/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ backend/

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]