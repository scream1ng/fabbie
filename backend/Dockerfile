FROM condaforge/miniforge3:latest

# Set the working directory
WORKDIR /app

# Install pythonocc-core using Conda and clean cache to keep image small
RUN conda install -y -c conda-forge pythonocc-core python=3.11 && \
    conda clean -afy

# Copy requirements and install pip dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend source code
COPY . .

# Railway sets the PORT environment variable dynamically
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]