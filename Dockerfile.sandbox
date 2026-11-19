FROM python:3.11-slim

# Install common data science + utility packages (kept in sync with the list in SYSTEM_PROMPT)
RUN pip install --no-cache-dir \
    numpy \
    pandas \
    matplotlib \
    seaborn \
    scipy \
    scikit-learn \
    requests \
    beautifulsoup4 \
    openpyxl \
    xlsxwriter \
    Pillow \
    sympy \
    tabulate \
    plotly

# No display → matplotlib uses the Agg backend
ENV MPLBACKEND=Agg

# Create non-root user
RUN useradd -m -s /bin/bash -u 1000 sandbox

# /workspace/runs/<run_id>/ is a volume shared with the server (see docker-compose.yml).
# The executor symlinks /workspace/output to the output/ of the run that is executing.
RUN mkdir -p /workspace/runs && chown -R sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace

# No CMD — command passed at runtime
