FROM node:22.11.0

RUN apt-get update && apt-get install -y netcat-openbsd && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV TZ="Europe/Vienna"

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
