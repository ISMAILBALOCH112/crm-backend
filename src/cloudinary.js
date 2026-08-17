const axios = require('axios');
const FormData = require('form-data');

const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'vtdxdwve';
const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || 'frph1y9b';

async function uploadMediaBuffer(buffer, mimeType = 'image/jpeg', kind = 'image') {
  let endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  let ext = 'jpg';
  if (kind === 'video') {
    endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`;
    ext = 'mp4';
  } else if (kind === 'audio') {
    endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`;
    ext = 'ogg';
  } else if (kind === 'document') {
    endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`;
    ext = 'bin';
  }

  const form = new FormData();
  form.append('file', buffer, { contentType: mimeType, filename: `chat.${ext}` });
  form.append('upload_preset', uploadPreset);
  form.append('folder', 'chat');

  const response = await axios.post(endpoint, form, {
    headers: form.getHeaders(),
  });
  return response.data.secure_url;
}

function displayImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const marker = '/image/upload/';
  const i = url.indexOf(marker);
  if (i < 0) return url;
  const rest = url.slice(i + marker.length);
  if (/(^|,)f_(jpg|png|webp|auto|gif)/.test(rest)) return url;
  return `${url.slice(0, i + marker.length)}f_jpg,q_auto,c_limit,w_1280/${rest}`;
}

module.exports = { uploadMediaBuffer, displayImageUrl };
