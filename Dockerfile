FROM asia.gcr.io/verycoolproject-dcf97/python:3.14@sha256:1d94ae0f3a54cef8930291587c645b730631edb0f0121c15114e3b5093de4147

WORKDIR /app

CMD ["python", "--version"]