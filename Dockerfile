# Google Cloud Run image for the Rasa assistant (the game itself is on GitHub Pages).
#
#   browser (GitHub Pages) ──HTTPS──► Cloud Run :$PORT  Rasa server
#                                                          └── action server (127.0.0.1:5055, internal)

# Rasa 3.6 supports Python 3.8–3.10.
FROM python:3.10-slim

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    RASA_TELEMETRY_ENABLED=false \
    PYTHONUNBUFFERED=1
WORKDIR /home/user/app

# Install Rasa first so this slow step is cached when only training data changes.
COPY --chown=user rasa/requirements.txt rasa/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --user -r rasa/requirements.txt

# Copy the assistant and train the model (models/ isn't uploaded).
COPY --chown=user rasa/ rasa/
COPY --chown=user deploy/run.sh deploy/run.sh
RUN cd rasa && rasa train

# Cloud Run tells the container which port to use in $PORT (8080 by default).
ENV PORT=8080
EXPOSE 8080
CMD ["bash", "deploy/run.sh"]
