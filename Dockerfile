FROM python:3.12-slim

WORKDIR /opt/exocortex

COPY build/requirements.txt build/requirements.txt
RUN pip install --no-cache-dir -r build/requirements.txt

COPY . .

EXPOSE 5000

CMD ["python", "build/server.py"]
