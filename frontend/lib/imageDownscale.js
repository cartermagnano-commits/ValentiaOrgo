// Downscale an image file to at most `maxDim` px on its longest side before
// upload. The backend caps recognition input at MAX_DIM=1024px regardless
// (app.py's _process downscales every upload before the OSR/vision read), so
// this is lossless in effect — it only avoids shipping bytes the backend
// throws away immediately. That matters once the backend sits behind
// Vercel's proxy, whose body limit (~4.5 MB) a full-resolution phone photo
// routinely exceeds well before it would ever hit the backend's own 8 MB cap.
//
// Non-image files (and images already within the bound) pass through
// untouched, and any failure along the way falls back to the original file
// rather than blocking the upload.
export async function downscaleImageFile(file, maxDim = 1600) {
  if (!file || !file.type || !file.type.startsWith('image/')) return file

  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`Could not read ${file.name} as an image.`))
      el.src = url
    })

    const longest = Math.max(img.width, img.height)
    if (!longest || longest <= maxDim) return file

    const scale = maxDim / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)

    // Keep PNG/WebP as-is (lossless — structure drawings compress far better
    // this way); anything else (photos are almost always JPEG already)
    // re-encodes as JPEG rather than an uncompressed PNG blowup.
    const mimeType = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg'
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, 0.92))
    if (!blob) return file

    return new File([blob], file.name, { type: mimeType, lastModified: Date.now() })
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}
