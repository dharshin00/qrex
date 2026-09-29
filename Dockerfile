# Python image shared by api, worker, beat and mock-platform
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/code:/code/api:/code/mock-platform
WORKDIR /code
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api/ api/
COPY workers/ workers/
COPY mock-platform/ mock-platform/
COPY seed/ seed/
COPY scripts/ scripts/
COPY tests/ tests/
COPY pytest.ini .
