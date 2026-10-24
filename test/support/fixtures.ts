export const clothingSchema = {
  properties: [
    {
      name: 'gender',
      type: 'enum',
      description: 'Audience',
      values: ['girls', 'boys'],
      filterable: true,
    },
    {
      name: 'type',
      type: 'string',
      description: 'Garment type',
      filterable: true,
    },
    { name: 'size', type: 'string', description: 'Size', variant: true },
    { name: 'unit_system', type: 'string', description: 'Size unit system' },
  ],
};

export const plainSchema = {
  properties: [{ name: 'brand', type: 'string', description: 'Brand' }],
};
