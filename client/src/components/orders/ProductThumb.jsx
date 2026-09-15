import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import ImageIcon from '@mui/icons-material/Image';
import api from '../../api/client';

/**
 * A product's picture, wherever it lives.
 *
 * Two sources, and the component is the only place that has to know there are
 * two: `image_url` is a link somebody pasted, and it goes straight into the
 * tag; a product carrying `has_image` holds its own bytes, and those come from
 * GET /api/products/:id/image — which needs the Authorization header, and a
 * plain `<img src>` does not send one. So the bytes are fetched as a blob and
 * handed to the tag as an object URL.
 *
 * THE CACHE IS THE POINT. The order form lists forty products and re-renders on
 * every keystroke in its search box; without a cache that is forty requests per
 * letter typed. The map is keyed on the product id and lives for the life of
 * the tab, holding a promise rather than a URL so that forty rows mounting in
 * the same tick make one request between them and not forty.
 *
 * Object URLs are deliberately NOT revoked on unmount: the cached promise
 * outlives the component, and revoking would break every other row still
 * showing the same picture — and the next mount, which expects the cache to
 * hold something it can still display. A tab's worth of forty 9KB thumbnails
 * is under half a megabyte, released when the tab closes.
 */
const cache = new Map();

function load(id) {
  if (!cache.has(id)) {
    cache.set(id, api.get(`/products/${id}/image`, { responseType: 'blob' })
      .then((res) => URL.createObjectURL(res.data))
      .catch(() => null));
  }
  return cache.get(id);
}

export default function ProductThumb({ product, size = 36, radius = 1 }) {
  const id = product?._id || product?.id;
  const [src, setSrc] = useState(product?.image_url || null);

  useEffect(() => {
    if (product?.image_url) { setSrc(product.image_url); return undefined; }
    if (!product?.has_image || !id) { setSrc(null); return undefined; }
    let alive = true;
    load(id).then((url) => { if (alive) setSrc(url); });
    return () => { alive = false; };
  }, [id, product?.image_url, product?.has_image]);

  const box = {
    width: size, height: size, borderRadius: radius, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  if (!src) {
    return (
      <Box sx={{ ...box, bgcolor: 'background.sunken', color: 'text.disabled' }}>
        <ImageIcon sx={{ fontSize: size * 0.5 }} />
      </Box>
    );
  }

  return (
    <Box
      component="img"
      src={src}
      alt=""
      loading="lazy"
      // contain, not cover: these are catalogue shots of bottles, brushes and
      // rolls on white. Cropping a mop to a square is how you stop being able
      // to tell it from a broom at 36 pixels.
      sx={{ ...box, objectFit: 'contain', bgcolor: 'common.white' }}
    />
  );
}
