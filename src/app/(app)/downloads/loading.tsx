// The boundary itself is the point: it makes Next partially prefetch this
// dynamic route. Everything visible is already on screen from the layout, so
// there is nothing to render while the page payload arrives.
export default function Loading() {
  return null;
}
