export interface PaginationOptions {
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export const getPaginationOptions = (page?: number, pageSize?: number): PaginationOptions => {
  const p = Math.max(1, page || 1);
  const ps = Math.min(100, Math.max(1, pageSize || 20));
  return { page: p, pageSize: ps };
};

export const getSkipValue = (page: number, pageSize: number): number => {
  return (page - 1) * pageSize;
};

export const createPaginatedResult = <T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResult<T> => {
  const totalPages = Math.ceil(total / pageSize);
  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};

