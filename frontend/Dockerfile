#syntax=docker/dockerfile:experimental
FROM node:14 as builder

ARG firebase_config

ENV FIREBASE_CONFIG=${firebase_config}

WORKDIR /

RUN git clone https://github.com/jitsucom/jitsu

WORKDIR /jitsu/configurator/frontend

RUN --mount=type=cache,target=/jitsu/configurator/frontend/node_modules yarn install

RUN --mount=type=cache,target=/jitsu/configurator/frontend/node_modules yarn build

FROM debian:bullseye-slim 

COPY --from=builder /jitsu/configurator/frontend/build/ /app/web/
