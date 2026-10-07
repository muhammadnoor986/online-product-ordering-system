// Previous / "Page X of Y" / Next buttons.
// `pagination` is the object the API returns: { page, totalPages, hasNextPage, ... }
function Pagination({ pagination, onPageChange }) {
  return (
    <nav className="pagination" aria-label="Pagination">
      <button
        type="button"
        className="button button-secondary"
        onClick={() => onPageChange(pagination.page - 1)}
        disabled={pagination.page <= 1}
      >
        Previous
      </button>
      <span>
        Page {pagination.page} of {pagination.totalPages}
      </span>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => onPageChange(pagination.page + 1)}
        disabled={!pagination.hasNextPage}
      >
        Next
      </button>
    </nav>
  );
}

export default Pagination;
