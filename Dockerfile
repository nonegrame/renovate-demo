FROM asia.gcr.io/verycoolproject-dcf97/python:3.14@sha256:8f5eaec97eb484400fb87855acd672616d82a64b416aae2adf2983215f3ff05a

WORKDIR /app

CMD ["python", "--version"]