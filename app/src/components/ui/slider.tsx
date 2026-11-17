import * as React from 'react';
import { cn } from '@/lib/utils';
import { Slider as SliderPrimitive } from 'radix-ui';

/** A bar with one handle, dragged or moved with the arrow keys. */
function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        'relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1.5 grow overflow-hidden rounded-full bg-input dark:bg-input/80"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={props['aria-label']}
        className="block size-4 cursor-grab rounded-full border border-primary bg-background shadow-sm transition-[box-shadow] outline-none hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/50 active:cursor-grabbing"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
