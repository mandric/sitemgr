FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY prototype/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy prototype source
COPY prototype/ ./prototype/

# Create sitemgr data directory
RUN mkdir -p /root/.sitemgr

# Default: run the watcher
ENV SMGR_DEVICE_ID=docker
ENV SMGR_S3_REGION=us-east-1

ENTRYPOINT ["python3"]
CMD ["prototype/smgr.py", "watch", "--once"]
