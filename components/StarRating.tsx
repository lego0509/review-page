'use client';

import { Star } from 'lucide-react';
import { useMemo } from 'react';
import clsx from 'clsx';

interface StarRatingProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  note?: string;
  required?: boolean;
}

const starValues = [1, 2, 3, 4, 5];

export function StarRating({ label, value, onChange, note, required }: StarRatingProps) {
  const displayNote = useMemo(() => (value ? `${value} / 5` : '未選択'), [value]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-sm font-semibold text-gray-800">
          {label}
          {required && <span className="text-xs font-semibold text-brand-600">*</span>}
        </label>
        <span className="text-xs font-semibold text-gray-500">{displayNote}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {starValues.map((star) => {
          const active = star <= value;
          return (
            <button
              key={star}
              type="button"
              aria-label={`${label} ${star}点`}
              className={clsx(
                'star-button',
                active ? 'bg-brand-50 border-brand-200 text-brand-600' : 'bg-softGray text-gray-400'
              )}
              onClick={() => onChange(star)}
            >
              <Star
                className={clsx('h-5 w-5', active ? 'fill-current text-brand-600' : 'text-gray-300')}
                strokeWidth={1.5}
              />
            </button>
          );
        })}
        {note && <span className="text-xs text-gray-500">{note}</span>}
      </div>
    </div>
  );
}

export default StarRating;
