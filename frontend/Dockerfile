FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:8000
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

FROM nginx:1.25-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 4173
CMD ["nginx", "-g", "daemon off;"]
